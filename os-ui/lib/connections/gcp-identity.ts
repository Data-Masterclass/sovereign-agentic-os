/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { createSign } from 'crypto';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Google Cloud identity/resource-governance client — the per-connection bridge to a
 * customer's GCP org via Cloud Resource Manager + IAM. This is the Google peer of
 * `entra.ts` (identity) / `purview.ts` (catalog): a governed, READ-ONLY governance
 * connection. OS agents list projects, read a project's IAM policy (who has which
 * role) and list service accounts to answer "who has access to what in GCP"
 * questions. There are NO writes — mutating IAM/resources is out of scope.
 *
 * AUTH (dependency-free, mirroring how `sagemaker.ts` does SigV4 without deps):
 * the vaulted credential is a GCP **service-account JSON key**. We sign a JWT
 * assertion (RS256 over the SA private key, using Node `crypto` `createSign`) and
 * exchange it at `https://oauth2.googleapis.com/token` (the JWT-bearer grant) for a
 * short-lived OAuth2 access token, then call the Google APIs with that Bearer. The
 * scope is `cloud-platform.read-only` — least-privilege, read-only.
 *
 * SECRETS: the SA JSON (which contains the `private_key` PEM) is the vaulted
 * credential (stored whole under one secret key, parsed HERE server-side). It NEVER
 * lands on the record, in a response, or in a log/trace; only the signed assertion
 * and the resulting access token cross the wire, and neither is returned to the
 * caller. Every call NEVER throws — `{ ok:false, reason }`; 401/403/404/429 mapped
 * honestly. Egress: `oauth2.googleapis.com` (token), `cloudresourcemanager.googleapis.com`,
 * `iam.googleapis.com`.
 */

export type GcpFetch = typeof fetch;

/** The fields we use from a GCP service-account JSON key (the rest is ignored). */
export type GcpServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type GcpConn = {
  sa?: GcpServiceAccount;
  fetchImpl: GcpFetch;
  timeoutMs?: number;
};

export type GcpResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

const PAGE = 25;
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CRM = 'https://cloudresourcemanager.googleapis.com/v1';
const IAM = 'https://iam.googleapis.com/v1';

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
 * Build a signed RS256 JWT assertion for the Google OAuth2 JWT-bearer grant.
 * Pure + deterministic given `now`: header + claim set are base64url-JSON, the
 * signature is `RSA-SHA256` over `<header>.<claims>` using the SA private key.
 * The private key is used ONLY to sign — it is never returned.
 */
export function signJwtAssertion(sa: GcpServiceAccount, now: number, opts?: { scope?: string; ttlSec?: number }): string {
  const aud = sa.token_uri || DEFAULT_TOKEN_URI;
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(now / 1000);
  const claims = {
    iss: sa.client_email,
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

/** Parse the vaulted SA JSON, tolerating `\n`-escaped PEMs. Returns undefined on junk. */
export function parseServiceAccount(raw: string | null | undefined): GcpServiceAccount | undefined {
  if (!raw) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const client_email = typeof obj.client_email === 'string' ? obj.client_email : '';
  let private_key = typeof obj.private_key === 'string' ? obj.private_key : '';
  // JSON keys often carry the PEM with literal `\n`; normalize to real newlines.
  if (private_key.includes('\\n')) private_key = private_key.replace(/\\n/g, '\n');
  if (!client_email || !private_key) return undefined;
  return { client_email, private_key, token_uri: typeof obj.token_uri === 'string' ? obj.token_uri : undefined };
}

/** Exchange the signed JWT assertion for a short-lived OAuth2 access token. Never throws. */
async function accessToken(conn: GcpConn): Promise<GcpResult<string>> {
  if (!conn.sa) return { ok: false, reason: 'no GCP service-account key set' };
  let assertion: string;
  try {
    assertion = signJwtAssertion(conn.sa, Date.now());
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
    if (!res.ok) return { ok: false, reason: `token exchange rejected (HTTP ${res.status}) — check the service-account key + scopes` };
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

/** One read GET against a Google API with a fresh Bearer. Never throws; maps errors honestly. */
async function get(conn: GcpConn, url: string): Promise<GcpResult<Record<string, unknown>>> {
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
    if (res.status === 401) return { ok: false, reason: 'unauthorized (token rejected — check the service-account key)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (missing read-only IAM/resource permission)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Google API ${res.status}` };
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** One read POST (IAM `:getIamPolicy`). Never throws; maps errors honestly. */
async function post(conn: GcpConn, url: string, body: Record<string, unknown>): Promise<GcpResult<Record<string, unknown>>> {
  const tok = await accessToken(conn);
  if (!tok.ok) return tok;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    const res = await conn.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.data}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (token rejected — check the service-account key)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (missing read-only IAM permission)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Google API ${res.status}` };
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- liveness -------

/** Liveness: list projects with pageSize=1 — a cheap token-exchange + read round-trip. 2xx ⇒ live. */
export async function gcpIdentityHealth(conn: GcpConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await get(conn, `${CRM}/projects?pageSize=1`);
  if (r.ok) return { connected: true, detail: 'Cloud Resource Manager reachable' };
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type GcpProject = { projectId: string; name: string; projectNumber: string; state: string };
export type GcpBinding = { role: string; members: string[] };
export type GcpServiceAccountRow = { email: string; displayName: string; uniqueId: string };

/** GET /projects — list projects the SA can see. Read. Bounded. */
export async function gcpListProjects(conn: GcpConn): Promise<GcpResult<GcpProject[]>> {
  const r = await get(conn, `${CRM}/projects?pageSize=${PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.projects) ? (r.data.projects as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      projectId: String(d.projectId ?? ''),
      name: String(d.name ?? ''),
      projectNumber: String(d.projectNumber ?? ''),
      state: String(d.lifecycleState ?? d.state ?? ''),
    })),
    truncated: Boolean(r.data.nextPageToken),
  };
}

/** POST /projects/{id}:getIamPolicy — read who holds which role on a project. Read. */
export async function gcpGetIamPolicy(conn: GcpConn, projectId: string): Promise<GcpResult<GcpBinding[]>> {
  if (!projectId.trim()) return { ok: false, reason: 'get_iam_policy needs a project id' };
  const r = await post(conn, `${CRM}/projects/${encodeURIComponent(projectId)}:getIamPolicy`, {});
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.bindings) ? (r.data.bindings as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      role: String(d.role ?? ''),
      members: Array.isArray(d.members) ? (d.members as unknown[]).map((m) => String(m)) : [],
    })),
  };
}

/** GET /projects/{id}/serviceAccounts — list a project's service accounts. Read. Bounded. */
export async function gcpListServiceAccounts(conn: GcpConn, projectId: string): Promise<GcpResult<GcpServiceAccountRow[]>> {
  if (!projectId.trim()) return { ok: false, reason: 'list_service_accounts needs a project id' };
  const r = await get(conn, `${IAM}/projects/${encodeURIComponent(projectId)}/serviceAccounts?pageSize=${PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.accounts) ? (r.data.accounts as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      email: String(d.email ?? ''),
      displayName: String(d.displayName ?? ''),
      uniqueId: String(d.uniqueId ?? ''),
    })),
    truncated: Boolean(r.data.nextPageToken),
  };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure GCP client config — the service-account JSON is dereferenced from
 *  the vault HERE (server-side), parsed, and never leaves this process. */
export function gcpIdentityConnFrom(c: Connection): GcpConn {
  return {
    sa: parseServiceAccount(getSecretServerSide(c.secretRef)),
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
