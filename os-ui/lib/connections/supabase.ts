/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { getConnectionForUser } from '@/lib/connections/store';
import { fetchWithBackoff } from '@/lib/connections/retry';

/**
 * Supabase MANAGEMENT-API client — the per-connection bridge to a customer's
 * Supabase organization for PROJECT operations (list projects/tables/migrations,
 * advisors, logs, a governed `execute_sql`). It is NOT the data pipe: the project's
 * actual Postgres is federated SEPARATELY as a read-only Trino `postgresql` catalog
 * (see the install guide + the postgres warehouse provider) — this client never
 * bulk-reads rows and never touches the service-role key.
 *
 * A governed OUTBOUND connection: the same capability gate every other connection
 * passes. Pure, testable client (`fetch` injected, the management PAT injected as an
 * ARG, never logged/returned) + a thin server bridge that resolves under the caller's
 * identity (DLS) and dereferences the vaulted token HERE.
 *
 * Same discipline as `airflow.ts`/`github.ts`: NEVER throws to the caller —
 * `{ ok:false, reason }`. Respects `429` + `Retry-After` (honest reason, no hammer).
 *
 * SECURITY §5: `execute_sql` is a governed admin escape hatch, held Write-approval
 * upstream. It REFUSES DDL/destructive statements here as a defence-in-depth guard
 * (DDL belongs to `apply_migration`, which is Blocked by default). Service-role keys
 * are NEVER surfaced in any result.
 */

export type SupabaseFetch = typeof fetch;

export const SUPABASE_API = 'https://api.supabase.com';

/** A per-connection Supabase Management client config. */
export type SupabaseConn = {
  baseUrl: string;
  /** The management access token (`sbp_…`), resolved from the vault. */
  token?: string;
  fetchImpl: SupabaseFetch;
  timeoutMs?: number;
};

export type SupabaseResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

/**
 * Auth headers. The management PAT is used ONLY to build the Authorization header;
 * never returned or logged. Absent token ⇒ no header (honest auth fail).
 */
export function supabaseAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: SupabaseConn): string {
  return (conn.baseUrl || SUPABASE_API).replace(/\/$/, '');
}

/** Validate a project ref before folding it into a path (never trust input). */
export function isValidProjectRef(ref: string): boolean {
  return /^[a-zA-Z0-9]{16,40}$/.test(ref);
}

/**
 * DDL / destructive guard for `execute_sql`. Returns the offending keyword when the
 * statement starts with (or contains a leading) DDL/destructive verb, else null.
 * Conservative: strips line/block comments first so `-- drop` can't smuggle a DROP.
 */
export function ddlGuard(sql: string): string | null {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .toLowerCase();
  const banned = ['drop', 'truncate', 'alter', 'create', 'grant', 'revoke', 'delete', 'update', 'insert'];
  for (const stmt of stripped.split(';')) {
    const first = stmt.trim().split(/\s+/)[0];
    if (first && banned.includes(first)) return first;
  }
  return null;
}

function rateReason(res: Response): string | null {
  const retryAfter = res.headers.get('retry-after');
  if (res.status === 429) return `rate-limited; retry after ${retryAfter ?? '60'}s`;
  return null;
}

async function withTimeout(conn: SupabaseConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function sbGet(conn: SupabaseConn, path: string): Promise<SupabaseResult<unknown>> {
  try {
    const res = await withTimeout(conn, `${base(conn)}${path}`, { method: 'GET', headers: supabaseAuthHeaders(conn.token) });
    const rl = rateReason(res);
    if (rl) return { ok: false, reason: rl };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (bad or missing token)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Supabase ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

async function sbPost(conn: SupabaseConn, path: string, body: Record<string, unknown>): Promise<SupabaseResult<unknown>> {
  try {
    const url = `${base(conn)}${path}`;
    const res = await fetchWithBackoff(
      url,
      { method: 'POST', headers: { ...supabaseAuthHeaders(conn.token), 'content-type': 'application/json' }, body: JSON.stringify(body) },
      (u, init) => withTimeout(conn, u, init!),
    );
    const rl = rateReason(res);
    if (rl) return { ok: false, reason: rl };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (bad or missing token)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Supabase ${res.status}` };
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

// ------------------------------------------------------------- liveness ---------

/**
 * Liveness: GET /v1/projects. 2xx ⇒ token live; 401 ⇒ honest ✗; network ⇒ unreachable.
 * The token is used ONLY as the bearer — never returned.
 */
export async function supabaseHealth(
  conn: SupabaseConn,
): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await sbGet(conn, '/v1/projects');
  if (r.ok) {
    const rows = Array.isArray(r.data) ? r.data : [];
    return { connected: true, detail: `${rows.length} project${rows.length === 1 ? '' : 's'} visible` };
  }
  return { connected: false, reason: r.reason };
}

// -------------------------------------------------------------- reads (auto) ----

export type SupabaseProject = { id: string; name: string; region: string; status: string };
export type SupabaseTable = { schema: string; name: string; rows?: number };
export type SupabaseMigration = { version: string; name: string };
export type SupabaseAdvisor = { level: string; category: string; title: string };

/** GET /v1/projects — list projects in the org. Read. Never surfaces keys. */
export async function listProjects(conn: SupabaseConn): Promise<SupabaseResult<SupabaseProject[]>> {
  const r = await sbGet(conn, '/v1/projects');
  if (!r.ok) return r;
  const rows = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
  return {
    ok: true,
    data: rows.map((d) => ({
      id: String(d.id ?? d.ref ?? ''),
      name: String(d.name ?? ''),
      region: String(d.region ?? ''),
      status: String(d.status ?? ''),
    })),
  };
}

/** GET /v1/projects/{ref}/database/tables — list tables (metadata only). Read. */
export async function listTables(conn: SupabaseConn, ref: string): Promise<SupabaseResult<SupabaseTable[]>> {
  if (!isValidProjectRef(ref)) return { ok: false, reason: 'project ref is invalid' };
  const r = await sbGet(conn, `/v1/projects/${ref}/database/tables`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map((d) => ({ schema: String(d.schema ?? 'public'), name: String(d.name ?? ''), rows: d.live_rows_estimate !== undefined ? Number(d.live_rows_estimate) : undefined })) };
}

/** GET /v1/projects/{ref}/database/migrations — list applied migrations. Read. */
export async function listMigrations(conn: SupabaseConn, ref: string): Promise<SupabaseResult<SupabaseMigration[]>> {
  if (!isValidProjectRef(ref)) return { ok: false, reason: 'project ref is invalid' };
  const r = await sbGet(conn, `/v1/projects/${ref}/database/migrations`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map((d) => ({ version: String(d.version ?? ''), name: String(d.name ?? '') })) };
}

/** GET /v1/projects/{ref}/advisors/{type} — security/performance advisors. Read. */
export async function getAdvisors(conn: SupabaseConn, ref: string, type: 'security' | 'performance' = 'security'): Promise<SupabaseResult<SupabaseAdvisor[]>> {
  if (!isValidProjectRef(ref)) return { ok: false, reason: 'project ref is invalid' };
  const t = type === 'performance' ? 'performance' : 'security';
  const r = await sbGet(conn, `/v1/projects/${ref}/advisors/${t}`);
  if (!r.ok) return r;
  const lints = ((r.data as { lints?: Record<string, unknown>[] })?.lints) ?? [];
  return { ok: true, data: lints.map((d) => ({ level: String(d.level ?? ''), category: String(d.categories ?? d.category ?? ''), title: String(d.title ?? d.name ?? '') })) };
}

/** GET /v1/projects/{ref}/analytics/endpoints/logs.all — recent logs. Read (bounded by API). */
export async function getLogs(conn: SupabaseConn, ref: string): Promise<SupabaseResult<unknown>> {
  if (!isValidProjectRef(ref)) return { ok: false, reason: 'project ref is invalid' };
  const r = await sbGet(conn, `/v1/projects/${ref}/analytics/endpoints/logs.all`);
  if (!r.ok) return r;
  const result = (r.data as { result?: unknown })?.result ?? r.data;
  return { ok: true, data: result };
}

/**
 * GET /v1/projects/{ref} → the project's API URL (non-secret). Read. NEVER returns
 * the anon/service-role keys — only the host URL an app connects to.
 */
export async function getProjectUrl(conn: SupabaseConn, ref: string): Promise<SupabaseResult<{ url: string }>> {
  if (!isValidProjectRef(ref)) return { ok: false, reason: 'project ref is invalid' };
  const r = await sbGet(conn, `/v1/projects/${ref}`);
  if (!r.ok) return r;
  // The project's REST host is derived from the ref; never expose keys from the body.
  return { ok: true, data: { url: `https://${ref}.supabase.co` } };
}

// ---------------------------------------------- write (Write-approval) ----------

/**
 * POST /v1/projects/{ref}/database/query — run one SQL statement. Governed admin
 * escape hatch: Write-approval upstream, AND it REFUSES DDL/destructive verbs here
 * (defence in depth — DDL belongs to `apply_migration`, which is Blocked). Never throws.
 */
export async function executeSql(conn: SupabaseConn, ref: string, sql: string): Promise<SupabaseResult<unknown>> {
  if (!isValidProjectRef(ref)) return { ok: false, reason: 'project ref is invalid' };
  if (!sql.trim()) return { ok: false, reason: 'execute_sql needs a query' };
  const banned = ddlGuard(sql);
  if (banned) return { ok: false, reason: `execute_sql refuses DDL/destructive SQL ("${banned}") — use apply_migration (Blocked by default) for schema changes` };
  const r = await sbPost(conn, `/v1/projects/${ref}/database/query`, { query: sql });
  if (!r.ok) return r;
  return { ok: true, data: r.data };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure client config from a resolved `supabase` connection. The token is
 *  dereferenced from the vault HERE and never leaves the server. */
export function supabaseConnFrom(c: Connection): SupabaseConn {
  return {
    baseUrl: c.endpoint || SUPABASE_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}

/** Resolve a `supabase` connection the caller may see. 404 for an unseeable id; 400 wrong type. */
export async function resolveSupabase(connId: string, user: CurrentUser): Promise<Connection> {
  const c = await getConnectionForUser(connId, user); // DLS guard (404)
  if (c.template !== 'supabase') {
    const e = new Error('Not a Supabase connection') as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return c;
}
