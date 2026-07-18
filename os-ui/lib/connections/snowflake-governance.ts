/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createSign, createPublicKey, createPrivateKey, createHash } from 'crypto';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Snowflake ACCOUNT_USAGE governance client — the per-connection bridge to a
 * customer's Snowflake for READ-ONLY security governance. This is the Snowflake peer
 * of `entra.ts` / `purview.ts`, and is DISTINCT from the data-warehouse
 * `warehouse/providers/snowflake.ts` (which federates business data through Trino):
 * here we read the `SNOWFLAKE.ACCOUNT_USAGE` schema — users, roles,
 * grants_to_users / grants_to_roles, and access/login history — to answer "who has
 * which role and grant, and who logged in / touched what" questions. There are NO
 * writes.
 *
 * AUTH (reuses the SAME RSA key-pair discipline as the warehouse provider):
 * Snowflake accepts a key-pair JWT on its SQL REST API. We sign a JWT (RS256 over
 * the user's RSA private key, dependency-free via Node `crypto`) whose `iss` is
 * `<ACCOUNT>.<USER>.SHA256:<fp>` (the fp being base64(sha256(DER SPKI public key)))
 * and `sub` is `<ACCOUNT>.<USER>`, then POST it as a Bearer to
 * `https://<account>.snowflakecomputing.com/api/v2/statements`. This mirrors the
 * warehouse provider's "RSA key-pair only, no password" rule.
 *
 * SECRETS: the credential is `<account>:<user>:<PEM>` (account + user are non-secret
 * routing, the PEM is the secret), vaulted under ONE key and split HERE server-side.
 * The private key is used ONLY to sign the JWT — it NEVER lands on the record, in a
 * response, or in a log/trace. Every call NEVER throws — `{ ok:false, reason }`;
 * 401/403/429 mapped honestly. Egress: `snowflakecomputing.com`
 * (`<account>.snowflakecomputing.com` via the subdomain rule).
 *
 * HONESTY: `SNOWFLAKE.ACCOUNT_USAGE` views have up to ~2h latency (they are not
 * real-time) and every query runs on a warehouse, consuming credits. Both caveats
 * are in the connector `notes` and the install guide.
 */

export type SnowflakeGovFetch = typeof fetch;

export type SnowflakeGovCreds = {
  /** Account identifier (e.g. `ORG-ACCOUNT`), upper-cased for the JWT iss/sub. */
  account: string;
  /** Login name, upper-cased for the JWT iss/sub. */
  user: string;
  /** Unencrypted PKCS#8 RSA private key (PEM). The only secret material. */
  privateKeyPem: string;
  /** The `<account>.snowflakecomputing.com` host derived from the account. */
  host: string;
};

export type SnowflakeGovConn = {
  creds?: SnowflakeGovCreds;
  fetchImpl: SnowflakeGovFetch;
  timeoutMs?: number;
};

export type SnowflakeGovResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

const ROW_LIMIT = 50;
const ACCOUNT_USAGE = 'SNOWFLAKE.ACCOUNT_USAGE';

// ------------------------------------------------------------------ JWT ---------

/** base64url of a Buffer/string (no padding) — the JOSE encoding. */
export function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The Snowflake public-key fingerprint: `SHA256:` + base64(sha256(DER-SPKI public
 * key)). Snowflake computes this from the registered public key; we derive the SAME
 * value from the PRIVATE key (deriving the public key via `crypto`), so the JWT `iss`
 * matches what Snowflake stored. Pure + deterministic.
 */
export function publicKeyFingerprint(privateKeyPem: string): string {
  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  const der = pub.export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
}

/**
 * Build a signed RS256 JWT for Snowflake key-pair auth. `iss` = `<ACCOUNT>.<USER>.<fp>`,
 * `sub` = `<ACCOUNT>.<USER>`; account + user are upper-cased (Snowflake stores them
 * upper). Pure + deterministic given `now`. The private key signs ONLY — never returned.
 */
export function signSnowflakeJwt(creds: SnowflakeGovCreds, now: number, opts?: { ttlSec?: number }): string {
  const account = creds.account.toUpperCase();
  const user = creds.user.toUpperCase();
  const qualified = `${account}.${user}`;
  const fp = publicKeyFingerprint(creds.privateKeyPem);
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(now / 1000);
  const claims = {
    iss: `${qualified}.${fp}`,
    sub: qualified,
    iat,
    exp: iat + (opts?.ttlSec ?? 3600),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(creds.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

// --------------------------------------------------------------- creds ----------

/**
 * Derive the `<account>.snowflakecomputing.com` host from a bare account locator OR a
 * full URL (mirrors the warehouse provider's `snowflakeHost`). Returns '' on junk so
 * the caller refuses rather than reaching a nonsense host.
 */
export function snowflakeGovHost(account: string): string {
  let raw = (account ?? '').trim();
  if (!raw) return '';
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].toLowerCase();
  const suffix = '.snowflakecomputing.com';
  const acct = raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(acct)) return '';
  return `${acct}${suffix}`;
}

/**
 * Split the vaulted `<account>:<user>:<PEM>` credential. The PEM itself contains
 * `:`s (in the `-----BEGIN...` armor spacing? no — but base64 has none; the header
 * has none either), but we only split on the FIRST TWO colons so the PEM survives
 * intact. Returns undefined on anything malformed. Server-side only.
 */
export function parseSnowflakeGovCreds(raw: string | null | undefined): SnowflakeGovCreds | undefined {
  if (!raw) return undefined;
  const i1 = raw.indexOf(':');
  if (i1 <= 0) return undefined;
  const i2 = raw.indexOf(':', i1 + 1);
  if (i2 <= i1 + 1) return undefined;
  const account = raw.slice(0, i1).trim();
  const user = raw.slice(i1 + 1, i2).trim();
  let privateKeyPem = raw.slice(i2 + 1).trim();
  if (privateKeyPem.includes('\\n')) privateKeyPem = privateKeyPem.replace(/\\n/g, '\n');
  const host = snowflakeGovHost(account);
  if (!account || !user || !privateKeyPem || !host) return undefined;
  return { account, user, privateKeyPem, host };
}

// --------------------------------------------------------------- transport ------

/**
 * Run ONE read-only SQL statement over the Snowflake SQL REST API
 * (`POST /api/v2/statements`) with a key-pair JWT. Never throws; maps errors
 * honestly. The statement is always a bounded SELECT built HERE (no user SQL).
 */
async function runSql(conn: SnowflakeGovConn, statement: string): Promise<SnowflakeGovResult<Record<string, unknown>[]>> {
  if (!conn.creds) return { ok: false, reason: 'no Snowflake key-pair credential set' };
  if (!conn.creds.host) return { ok: false, reason: 'could not derive the Snowflake account host' };
  let jwt: string;
  try {
    jwt = signSnowflakeJwt(conn.creds, Date.now());
  } catch {
    return { ok: false, reason: 'could not sign the Snowflake JWT (invalid RSA private key)' };
  }
  const url = `https://${conn.creds.host}/api/v2/statements`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    const res = await conn.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ statement, timeout: 30 }),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.status === 429 || res.status === 503) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (key-pair JWT rejected — check the account/user + registered public key)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (the role lacks IMPORTED PRIVILEGES on the SNOWFLAKE database)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Snowflake ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // The SQL API returns `data` as an array of row arrays, aligned with
    // resultSetMetaData.rowType (column names). Shape to objects here.
    const meta = (j.resultSetMetaData ?? {}) as Record<string, unknown>;
    const cols = Array.isArray(meta.rowType) ? (meta.rowType as Record<string, unknown>[]).map((c) => String(c.name ?? '')) : [];
    const data = Array.isArray(j.data) ? (j.data as unknown[][]) : [];
    const rows = data.map((r) => {
      const o: Record<string, unknown> = {};
      cols.forEach((name, idx) => { o[name] = r[idx]; });
      return o;
    });
    return { ok: true, data: rows, truncated: rows.length >= ROW_LIMIT };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- liveness -------

/** Liveness: a cheap `SELECT CURRENT_ACCOUNT()` round-trip. 2xx ⇒ live; 401 ⇒ honest ✗. */
export async function snowflakeGovHealth(conn: SnowflakeGovConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await runSql(conn, 'SELECT CURRENT_ACCOUNT() AS ACCOUNT');
  if (r.ok) {
    const acct = r.data[0] ? String(Object.values(r.data[0])[0] ?? '') : '';
    return { connected: true, detail: acct ? `account ${acct} reachable` : 'reachable' };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type SnowflakeGovRow = Record<string, unknown>;

/** Read ACCOUNT_USAGE.USERS — directory of users (name, disabled, last login). Read. Bounded. */
export async function snowflakeGovListUsers(conn: SnowflakeGovConn): Promise<SnowflakeGovResult<SnowflakeGovRow[]>> {
  return runSql(conn, `SELECT NAME, LOGIN_NAME, DISABLED, LAST_SUCCESS_LOGIN, HAS_RSA_PUBLIC_KEY FROM ${ACCOUNT_USAGE}.USERS WHERE DELETED_ON IS NULL ORDER BY NAME LIMIT ${ROW_LIMIT}`);
}

/** Read ACCOUNT_USAGE.ROLES — the account's roles. Read. Bounded. */
export async function snowflakeGovListRoles(conn: SnowflakeGovConn): Promise<SnowflakeGovResult<SnowflakeGovRow[]>> {
  return runSql(conn, `SELECT NAME, COMMENT, CREATED_ON FROM ${ACCOUNT_USAGE}.ROLES WHERE DELETED_ON IS NULL ORDER BY NAME LIMIT ${ROW_LIMIT}`);
}

/** Read ACCOUNT_USAGE.GRANTS_TO_USERS — which roles are granted to which users. Read. Bounded. */
export async function snowflakeGovGrantsToUsers(conn: SnowflakeGovConn): Promise<SnowflakeGovResult<SnowflakeGovRow[]>> {
  return runSql(conn, `SELECT GRANTEE_NAME, ROLE, GRANTED_BY, CREATED_ON FROM ${ACCOUNT_USAGE}.GRANTS_TO_USERS WHERE DELETED_ON IS NULL ORDER BY GRANTEE_NAME LIMIT ${ROW_LIMIT}`);
}

/** Read ACCOUNT_USAGE.GRANTS_TO_ROLES — the privilege/role graph. Read. Bounded. */
export async function snowflakeGovGrantsToRoles(conn: SnowflakeGovConn): Promise<SnowflakeGovResult<SnowflakeGovRow[]>> {
  return runSql(conn, `SELECT GRANTEE_NAME, PRIVILEGE, GRANTED_ON, NAME, GRANTED_BY FROM ${ACCOUNT_USAGE}.GRANTS_TO_ROLES WHERE DELETED_ON IS NULL ORDER BY GRANTEE_NAME LIMIT ${ROW_LIMIT}`);
}

/** Read ACCOUNT_USAGE.LOGIN_HISTORY — recent logins (who, when, success, method). Read. Bounded. */
export async function snowflakeGovLoginHistory(conn: SnowflakeGovConn): Promise<SnowflakeGovResult<SnowflakeGovRow[]>> {
  return runSql(conn, `SELECT USER_NAME, EVENT_TIMESTAMP, IS_SUCCESS, FIRST_AUTHENTICATION_FACTOR, CLIENT_IP FROM ${ACCOUNT_USAGE}.LOGIN_HISTORY ORDER BY EVENT_TIMESTAMP DESC LIMIT ${ROW_LIMIT}`);
}

/** Read ACCOUNT_USAGE.ACCESS_HISTORY — recent object access by query (audit). Read. Bounded. */
export async function snowflakeGovAccessHistory(conn: SnowflakeGovConn): Promise<SnowflakeGovResult<SnowflakeGovRow[]>> {
  return runSql(conn, `SELECT USER_NAME, QUERY_START_TIME, QUERY_ID FROM ${ACCOUNT_USAGE}.ACCESS_HISTORY ORDER BY QUERY_START_TIME DESC LIMIT ${ROW_LIMIT}`);
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Snowflake-governance client config — the RSA private key is
 *  dereferenced from the vault HERE (server-side), split off, and never leaves. */
export function snowflakeGovConnFrom(c: Connection): SnowflakeGovConn {
  return {
    creds: parseSnowflakeGovCreds(getSecretServerSide(c.secretRef)),
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
