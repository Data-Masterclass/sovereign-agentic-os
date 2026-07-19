/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createSign } from 'crypto';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { base64url } from '@/lib/connections/gcp-identity';

/**
 * Google Workspace **directory** governance client — the per-connection bridge to a
 * customer's Google Workspace via the Admin SDK Directory API. This is the READ-ONLY
 * Workspace-directory PEER of `gcp-identity.ts` (Cloud IAM): where gcp-identity
 * answers "who has which role in GCP", this answers "who is in the Workspace, in
 * which org units / groups, holding which admin roles". OS agents list users,
 * groups, org units, admin roles and verified domains to answer directory-governance
 * questions. There are NO writes — mutating the directory is out of scope.
 *
 * AUTH (dependency-free, mirroring `gcp-identity.ts`): the vaulted credential is a
 * GCP **service-account JSON key** — BUT the Admin SDK requires **domain-wide
 * delegation**, so the SA impersonates a real Workspace admin. Two extra non-secret
 * fields ride along in the SAME pasted JSON blob (they are NOT secrets, only routing):
 *   • `subject` (a.k.a. `admin_email`) — the admin user the SA impersonates. This
 *     becomes the JWT `sub` claim; the SA reads THAT admin's directory.
 *   • `customer` — the customer id to enumerate (usually `my_customer`).
 * We sign an RS256 JWT assertion (Node `crypto` `createSign`) with `sub` = subject
 * and scope `admin.directory.readonly`, exchange it at `oauth2.googleapis.com/token`
 * for a short-lived bearer, then call the Admin SDK with that bearer.
 *
 * SECRETS: the SA JSON (which contains the `private_key` PEM) is the vaulted
 * credential — stored whole under one secret key, parsed HERE server-side. It NEVER
 * lands on the record, in a response, or in a log/trace; only the signed assertion
 * and the resulting access token cross the wire, and neither is returned to the
 * caller. Every call NEVER throws — `{ ok:false, reason }`; 401/403/404/429 mapped
 * honestly. Egress: `oauth2.googleapis.com` (token), `admin.googleapis.com` (reads).
 */

export type GcpFetch = typeof fetch;

/**
 * The fields we use from an EXTENDED GCP service-account JSON key: the standard SA
 * key fields plus the two non-secret domain-wide-delegation routing fields the user
 * adds (`subject`/`admin_email` + `customer`). The rest of the JSON is ignored.
 */
export type GcpDirectoryAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
  /** The impersonated Workspace admin — becomes the JWT `sub` claim. */
  subject: string;
  /** The Workspace customer to enumerate (defaults to `my_customer`). */
  customer: string;
};

export type GcpDirConn = {
  sa?: GcpDirectoryAccount;
  fetchImpl: GcpFetch;
  timeoutMs?: number;
};

export type GcpDirResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

const PAGE = 25;
// Domain-wide-delegation scope — read-only directory. This EXACT scope string must
// be authorized (against the SA's client id) in the Workspace Admin console.
const SCOPE = 'https://www.googleapis.com/auth/admin.directory.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DIR = 'https://admin.googleapis.com/admin/directory/v1';
const DEFAULT_CUSTOMER = 'my_customer';

// ------------------------------------------------------------------ JWT ---------

/**
 * Build a signed RS256 JWT assertion for the Google OAuth2 JWT-bearer grant WITH a
 * `sub` claim — the domain-wide-delegation twist. Pure + deterministic given `now`:
 * header + claim set are base64url-JSON (reusing `base64url` from gcp-identity), the
 * signature is `RSA-SHA256` over `<header>.<claims>` using the SA private key. The
 * private key is used ONLY to sign — it is never returned. `sub` = the impersonated
 * admin so the exchanged token reads THAT admin's Workspace directory.
 */
export function signDirectoryJwt(sa: GcpDirectoryAccount, now: number, opts?: { scope?: string; ttlSec?: number }): string {
  const aud = sa.token_uri || DEFAULT_TOKEN_URI;
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(now / 1000);
  const claims = {
    iss: sa.client_email,
    sub: sa.subject, // domain-wide delegation: impersonate this Workspace admin
    scope: opts?.scope ?? SCOPE,
    aud,
    iat,
    exp: iat + (opts?.ttlSec ?? 3600),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

// --------------------------------------------------------------- transport ------

/**
 * Parse the vaulted EXTENDED SA JSON — the standard SA key plus the two non-secret
 * delegation fields (`subject`/`admin_email` + `customer`). Tolerates `\n`-escaped
 * PEMs. Returns undefined on junk or when `subject` is missing (delegation can't work
 * without an admin to impersonate). Server-side only.
 */
export function parseDirectoryAccount(raw: string | null | undefined): GcpDirectoryAccount | undefined {
  if (!raw) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const client_email = typeof obj.client_email === 'string' ? obj.client_email : '';
  let private_key = typeof obj.private_key === 'string' ? obj.private_key : '';
  if (private_key.includes('\\n')) private_key = private_key.replace(/\\n/g, '\n');
  // The impersonated admin — accept either `subject` or the friendlier `admin_email`.
  const subject =
    (typeof obj.subject === 'string' && obj.subject) ||
    (typeof obj.admin_email === 'string' && obj.admin_email) ||
    '';
  const customer = (typeof obj.customer === 'string' && obj.customer.trim()) || DEFAULT_CUSTOMER;
  if (!client_email || !private_key || !subject) return undefined;
  return {
    client_email,
    private_key,
    token_uri: typeof obj.token_uri === 'string' ? obj.token_uri : undefined,
    subject,
    customer,
  };
}

/** Exchange the signed JWT assertion for a short-lived OAuth2 access token. Never throws. */
async function accessToken(conn: GcpDirConn): Promise<GcpDirResult<string>> {
  if (!conn.sa) return { ok: false, reason: 'no GCP service-account key + admin subject set' };
  let assertion: string;
  try {
    assertion = signDirectoryJwt(conn.sa, Date.now());
  } catch {
    return { ok: false, reason: 'could not sign the JWT assertion (invalid service-account private key)' };
  }
  const tokenUri = conn.sa.token_uri || DEFAULT_TOKEN_URI;
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    const res = await conn.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (!res.ok) return { ok: false, reason: `token exchange rejected (HTTP ${res.status}) — check the key, the domain-wide-delegation authorization, and the admin subject` };
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const tok = typeof j.access_token === 'string' ? j.access_token : '';
    if (!tok) return { ok: false, reason: 'token exchange returned no access_token' };
    return { ok: true, data: tok };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** One read GET against the Admin SDK with a fresh Bearer. Never throws; maps errors honestly. */
async function get(conn: GcpDirConn, url: string): Promise<GcpDirResult<Record<string, unknown>>> {
  const tok = await accessToken(conn);
  if (!tok.ok) return tok;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    const res = await conn.fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${tok.data}`, accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (token rejected — check the service-account key + delegation)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (missing admin.directory.readonly delegation or the subject is not an admin)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Admin SDK ${res.status}` };
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- liveness -------

/** Liveness: list users (maxResults=1) — a cheap token-exchange + read round-trip. 2xx ⇒ live. */
export async function gcpDirectoryHealth(conn: GcpDirConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const customer = conn.sa?.customer || DEFAULT_CUSTOMER;
  const r = await get(conn, `${DIR}/users?customer=${encodeURIComponent(customer)}&maxResults=1`);
  if (r.ok) return { connected: true, detail: 'Admin SDK Directory reachable' };
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type GcpDirUser = { id: string; primaryEmail: string; fullName: string; isAdmin: boolean; suspended: boolean; orgUnitPath: string };
export type GcpDirGroup = { id: string; email: string; name: string; description: string; directMembersCount: string };
export type GcpDirOrgUnit = { orgUnitId: string; name: string; orgUnitPath: string; parentOrgUnitPath: string };
export type GcpDirRole = { roleId: string; roleName: string; roleDescription: string; isSystemRole: boolean; isSuperAdminRole: boolean };
export type GcpDirDomain = { domainName: string; isPrimary: boolean; verified: boolean };

/** GET /users?customer=… — list Workspace users. Read. Bounded. */
export async function gcpDirListUsers(conn: GcpDirConn): Promise<GcpDirResult<GcpDirUser[]>> {
  const customer = conn.sa?.customer || DEFAULT_CUSTOMER;
  const r = await get(conn, `${DIR}/users?customer=${encodeURIComponent(customer)}&maxResults=${PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.users) ? (r.data.users as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      id: String(d.id ?? ''),
      primaryEmail: String(d.primaryEmail ?? ''),
      fullName: String((d.name as Record<string, unknown> | undefined)?.fullName ?? ''),
      isAdmin: Boolean(d.isAdmin),
      suspended: Boolean(d.suspended),
      orgUnitPath: String(d.orgUnitPath ?? ''),
    })),
    truncated: Boolean(r.data.nextPageToken),
  };
}

/** GET /groups?customer=… — list Workspace groups. Read. Bounded. */
export async function gcpDirListGroups(conn: GcpDirConn): Promise<GcpDirResult<GcpDirGroup[]>> {
  const customer = conn.sa?.customer || DEFAULT_CUSTOMER;
  const r = await get(conn, `${DIR}/groups?customer=${encodeURIComponent(customer)}&maxResults=${PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.groups) ? (r.data.groups as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      id: String(d.id ?? ''),
      email: String(d.email ?? ''),
      name: String(d.name ?? ''),
      description: String(d.description ?? ''),
      directMembersCount: String(d.directMembersCount ?? ''),
    })),
    truncated: Boolean(r.data.nextPageToken),
  };
}

/** GET /customer/{customer}/orgunits — list org units (full tree). Read. */
export async function gcpDirListOrgUnits(conn: GcpDirConn): Promise<GcpDirResult<GcpDirOrgUnit[]>> {
  const customer = conn.sa?.customer || DEFAULT_CUSTOMER;
  const r = await get(conn, `${DIR}/customer/${encodeURIComponent(customer)}/orgunits?type=all`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.organizationUnits) ? (r.data.organizationUnits as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      orgUnitId: String(d.orgUnitId ?? ''),
      name: String(d.name ?? ''),
      orgUnitPath: String(d.orgUnitPath ?? ''),
      parentOrgUnitPath: String(d.parentOrgUnitPath ?? ''),
    })),
  };
}

/** GET /customer/{customer}/roles — list admin roles. Read. Bounded. */
export async function gcpDirListRoles(conn: GcpDirConn): Promise<GcpDirResult<GcpDirRole[]>> {
  const customer = conn.sa?.customer || DEFAULT_CUSTOMER;
  const r = await get(conn, `${DIR}/customer/${encodeURIComponent(customer)}/roles?maxResults=${PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.items) ? (r.data.items as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      roleId: String(d.roleId ?? ''),
      roleName: String(d.roleName ?? ''),
      roleDescription: String(d.roleDescription ?? ''),
      isSystemRole: Boolean(d.isSystemRole),
      isSuperAdminRole: Boolean(d.isSuperAdminRole),
    })),
    truncated: Boolean(r.data.nextPageToken),
  };
}

/** GET /customer/{customer}/domains — list verified domains. Read. */
export async function gcpDirListDomains(conn: GcpDirConn): Promise<GcpDirResult<GcpDirDomain[]>> {
  const customer = conn.sa?.customer || DEFAULT_CUSTOMER;
  const r = await get(conn, `${DIR}/customer/${encodeURIComponent(customer)}/domains`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.domains) ? (r.data.domains as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      domainName: String(d.domainName ?? ''),
      isPrimary: Boolean(d.isPrimary),
      verified: Boolean(d.verified),
    })),
  };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Admin SDK client config — the extended service-account JSON is
 *  dereferenced from the vault HERE (server-side), parsed, and never leaves this
 *  process. The `subject` + `customer` ride in the same blob (non-secret routing). */
export function gcpDirectoryConnFrom(c: Connection): GcpDirConn {
  return {
    sa: parseDirectoryAccount(getSecretServerSide(c.secretRef)),
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
