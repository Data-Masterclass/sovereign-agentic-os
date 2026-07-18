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
 * Atlassian client — Jira (`/rest/api/3/…`) + Confluence (`/wiki/rest/api/…`) Cloud
 * over a customer's `https://<site>.atlassian.net`. A governed OUTBOUND connection:
 * the same capability gate every other connection passes. Pure, testable client
 * (`fetch` injected, the credential injected as an ARG, never logged/returned) + a
 * thin server bridge that resolves under the caller's identity (DLS) and dereferences
 * the vaulted token HERE.
 *
 * Discipline as `airflow.ts`/`github.ts`: NEVER throws — `{ ok:false, reason }`.
 *
 * AUTH: two shapes. An **API token** is sent as HTTP Basic `email:token`
 * (Atlassian's documented API-token auth); an **OAuth 3LO** access token is sent as
 * `Bearer`. The connection's non-secret config carries the account email (for Basic)
 * and whether the credential is a bearer token. The site host is the endpoint.
 *
 * QUIRKS (§5): Jira/Confluence bodies are **ADF** (Atlassian Document Format) — plain
 * text is wrapped into ADF here. Reads paginate via `startAt`/`maxResults` (Jira) and
 * `start`/`limit` (Confluence), bounded with a `truncated` flag. `429` + `Retry-After`
 * is surfaced as an honest reason (no hammer). Tools are prefixed per product.
 */

export type AtlassianFetch = typeof fetch;

/** How the credential authenticates. */
export type AtlassianAuthKind = 'basic' | 'bearer';

/** Max rows per Atlassian page (Jira/Confluence both accept 50 max). */
export const ATLASSIAN_MAX_RESULTS = 50;
/** Max pages to follow before flagging `truncated` (guards against huge result sets). */
export const ATLASSIAN_MAX_PAGES = 5;

export type AtlassianConn = {
  /** The site base, e.g. https://acme.atlassian.net (Jira + Confluence live under it). */
  baseUrl: string;
  authKind: AtlassianAuthKind;
  /** Basic-auth account email (non-secret). Only meaningful for `basic`. */
  email?: string;
  /** The secret — the API token (Basic password) or the OAuth bearer (resolved from vault). */
  secret?: string;
  fetchImpl: AtlassianFetch;
  timeoutMs?: number;
};

export type AtlassianResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

/**
 * Auth headers. `basic` → `Authorization: Basic base64(email:token)`; `bearer` →
 * `Authorization: Bearer <token>`. The secret is used ONLY to build the header; it is
 * never returned or logged. Absent secret ⇒ no header (honest auth fail).
 */
export function atlassianAuthHeaders(conn: AtlassianConn): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (!conn.secret) return h;
  if (conn.authKind === 'basic') {
    const raw = `${conn.email ?? ''}:${conn.secret}`;
    h.authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  } else {
    h.authorization = `Bearer ${conn.secret}`;
  }
  return h;
}

function base(conn: AtlassianConn): string {
  return conn.baseUrl.replace(/\/$/, '');
}

/** Wrap plain text into a minimal ADF document (Jira/Confluence bodies are ADF). */
export function textToAdf(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

function rateReason(res: Response): string | null {
  if (res.status === 429) return `rate-limited; retry after ${res.headers.get('retry-after') ?? '60'}s`;
  return null;
}

async function withTimeout(conn: AtlassianConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

function mapAtlResponse(res: Response, tag: string): AtlassianResult<unknown> | null {
  const rl = rateReason(res);
  if (rl) return { ok: false, reason: rl };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized (bad token or missing project/space access)' };
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) return { ok: false, reason: `${tag} ${res.status}` };
  return null; // ok — caller reads the body
}

/** GET — no retry (429 surfaces immediately as honest reason). */
async function atlGet(conn: AtlassianConn, path: string): Promise<AtlassianResult<unknown>> {
  try {
    const res = await withTimeout(conn, `${base(conn)}${path}`, { method: 'GET', headers: atlassianAuthHeaders(conn) });
    const err = mapAtlResponse(res, 'Atlassian');
    if (err) return err;
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** POST/PUT — capped exponential backoff with jitter on 429/503 (one retry). */
async function atlWrite(
  conn: AtlassianConn,
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown>,
): Promise<AtlassianResult<unknown>> {
  try {
    const init: RequestInit = { method, headers: { ...atlassianAuthHeaders(conn), 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetchWithBackoff(`${base(conn)}${path}`, init, (u, i) => withTimeout(conn, u, i!), { maxAttempts: 2 });
    const err = mapAtlResponse(res, 'Atlassian');
    if (err) return err;
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

// ------------------------------------------------------------- liveness ---------

/**
 * Liveness: GET /rest/api/3/myself. 2xx ⇒ token live; 401/403 ⇒ honest ✗; network ⇒
 * unreachable. The token is used ONLY as the auth header — never returned.
 */
export async function atlassianHealth(
  conn: AtlassianConn,
): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await atlGet(conn, '/rest/api/3/myself');
  if (r.ok) {
    const d = r.data as { displayName?: string; emailAddress?: string };
    return { connected: true, detail: d.displayName ? `authenticated as ${d.displayName}` : undefined };
  }
  return { connected: false, reason: r.reason };
}

// -------------------------------------------------------------- reads (auto) ----

export type JiraIssue = { key: string; summary: string; status: string; assignee: string };
export type JiraProject = { key: string; name: string };
export type ConfluencePage = { id: string; title: string; url: string };

function shapeJiraIssue(d: Record<string, unknown>): JiraIssue {
  const fields = (d.fields ?? {}) as Record<string, unknown>;
  const status = (fields.status ?? {}) as { name?: string };
  const assignee = (fields.assignee ?? {}) as { displayName?: string };
  return {
    key: String(d.key ?? ''),
    summary: String(fields.summary ?? ''),
    status: String(status.name ?? ''),
    assignee: String(assignee.displayName ?? ''),
  };
}

/** GET /rest/api/3/search?jql=… — search Jira issues. Read, bounded → truncated.
 *  Follows `startAt` cursor up to `ATLASSIAN_MAX_PAGES` pages. */
export async function jiraSearchIssues(conn: AtlassianConn, jql: string): Promise<AtlassianResult<JiraIssue[]>> {
  const rows: JiraIssue[] = [];
  let startAt = 0;
  let pages = 0;
  let truncated = false;
  while (pages < ATLASSIAN_MAX_PAGES) {
    const q = new URLSearchParams({ jql: jql || 'order by created DESC', startAt: String(startAt), maxResults: String(ATLASSIAN_MAX_RESULTS) });
    const r = await atlGet(conn, `/rest/api/3/search?${q.toString()}`);
    if (!r.ok) return r;
    const body = r.data as { issues?: Record<string, unknown>[]; total?: number };
    const page = (body.issues ?? []).map(shapeJiraIssue);
    for (const row of page) rows.push(row);
    pages += 1;
    const total = typeof body.total === 'number' ? body.total : 0;
    startAt += page.length;
    // Use total as the primary signal; fall back to empty page as safety guard.
    if (startAt >= total || page.length === 0) break;
    if (pages >= ATLASSIAN_MAX_PAGES) { truncated = true; break; }
  }
  return { ok: true, data: rows, truncated };
}

/** GET /rest/api/3/issue/{key} — read one Jira issue. Read. */
export async function jiraGetIssue(conn: AtlassianConn, key: string): Promise<AtlassianResult<JiraIssue>> {
  if (!key.trim()) return { ok: false, reason: 'jira_get_issue needs an issue key' };
  const r = await atlGet(conn, `/rest/api/3/issue/${encodeURIComponent(key)}`);
  if (!r.ok) return r;
  return { ok: true, data: shapeJiraIssue(r.data as Record<string, unknown>) };
}

/** GET /rest/api/3/project/search — list Jira projects. Read, bounded → truncated.
 *  Follows `startAt` cursor up to `ATLASSIAN_MAX_PAGES` pages. */
export async function jiraListProjects(conn: AtlassianConn): Promise<AtlassianResult<JiraProject[]>> {
  const rows: JiraProject[] = [];
  let startAt = 0;
  let pages = 0;
  let truncated = false;
  while (pages < ATLASSIAN_MAX_PAGES) {
    const r = await atlGet(conn, `/rest/api/3/project/search?startAt=${startAt}&maxResults=${ATLASSIAN_MAX_RESULTS}`);
    if (!r.ok) return r;
    const body = r.data as { values?: Record<string, unknown>[]; total?: number; isLast?: boolean };
    const page = (body.values ?? []).map((d) => ({ key: String(d.key ?? ''), name: String(d.name ?? '') }));
    for (const row of page) rows.push(row);
    pages += 1;
    // `isLast` is the primary signal; empty page is a safety guard.
    if (body.isLast === true || page.length === 0) break;
    startAt += page.length;
    if (pages >= ATLASSIAN_MAX_PAGES) { truncated = true; break; }
  }
  return { ok: true, data: rows, truncated };
}

/** GET /wiki/rest/api/content/search?cql=… — search Confluence. Read, bounded → truncated.
 *  Follows `start` cursor up to `ATLASSIAN_MAX_PAGES` pages. */
export async function confluenceSearch(conn: AtlassianConn, cql: string): Promise<AtlassianResult<ConfluencePage[]>> {
  if (!cql.trim()) return { ok: false, reason: 'confluence_search needs a CQL query' };
  const rows: ConfluencePage[] = [];
  let start = 0;
  let pages = 0;
  let truncated = false;
  while (pages < ATLASSIAN_MAX_PAGES) {
    const q = new URLSearchParams({ cql, start: String(start), limit: String(ATLASSIAN_MAX_RESULTS) });
    const r = await atlGet(conn, `/wiki/rest/api/content/search?${q.toString()}`);
    if (!r.ok) return r;
    const body = r.data as { results?: Record<string, unknown>[]; size?: number; totalSize?: number };
    const page = (body.results ?? []).map((d) => ({
      id: String(d.id ?? ''),
      title: String(d.title ?? ''),
      url: String(((d._links as { webui?: string })?.webui) ?? ''),
    }));
    for (const row of page) rows.push(row);
    pages += 1;
    const totalSize = typeof body.totalSize === 'number' ? body.totalSize : 0;
    start += page.length;
    // Use totalSize as the primary signal; fall back to empty page as safety guard.
    if (start >= totalSize || page.length === 0) break;
    if (pages >= ATLASSIAN_MAX_PAGES) { truncated = true; break; }
  }
  return { ok: true, data: rows, truncated };
}

/** GET /wiki/rest/api/content/{id} — read one Confluence page. Read. */
export async function confluenceGetPage(conn: AtlassianConn, id: string): Promise<AtlassianResult<ConfluencePage>> {
  if (!id.trim()) return { ok: false, reason: 'confluence_get_page needs a page id' };
  const r = await atlGet(conn, `/wiki/rest/api/content/${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return { ok: true, data: { id: String(d.id ?? id), title: String(d.title ?? ''), url: String(((d._links as { webui?: string })?.webui) ?? '') } };
}

// ---------------------------------------------- writes (Write-approval) ---------

/**
 * POST /rest/api/3/issue — create a Jira issue. The description is sent as ADF.
 * Write — Write-approval upstream. Never throws.
 */
export async function jiraCreateIssue(
  conn: AtlassianConn,
  input: { projectKey: string; issueType: string; summary: string; description?: string },
): Promise<AtlassianResult<{ key: string; url: string }>> {
  if (!input.projectKey.trim() || !input.summary.trim()) return { ok: false, reason: 'jira_create_issue needs a projectKey and a summary' };
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype: { name: input.issueType || 'Task' },
    summary: input.summary,
  };
  if (input.description) fields.description = textToAdf(input.description);
  const r = await atlWrite(conn, 'POST', '/rest/api/3/issue', { fields });
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  const key = String(d.key ?? '');
  return { ok: true, data: { key, url: key ? `${base(conn)}/browse/${key}` : '' } };
}

/** POST /rest/api/3/issue/{key}/comment — comment on a Jira issue (ADF). Write. */
export async function jiraAddComment(conn: AtlassianConn, key: string, body: string): Promise<AtlassianResult<{ id: string }>> {
  if (!key.trim()) return { ok: false, reason: 'jira_add_comment needs an issue key' };
  if (!body.trim()) return { ok: false, reason: 'jira_add_comment needs a body' };
  const r = await atlWrite(conn, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(body) });
  if (!r.ok) return r;
  return { ok: true, data: { id: String((r.data as Record<string, unknown>).id ?? '') } };
}

/** POST /rest/api/3/issue/{key}/transitions — move an issue's status. Write. */
export async function jiraTransitionIssue(conn: AtlassianConn, key: string, transitionId: string): Promise<AtlassianResult<{ transitioned: true }>> {
  if (!key.trim() || !transitionId.trim()) return { ok: false, reason: 'jira_transition_issue needs an issue key and a transitionId' };
  const r = await atlWrite(conn, 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transitionId } });
  if (!r.ok) return r;
  return { ok: true, data: { transitioned: true } };
}

/**
 * POST /wiki/rest/api/content — create a Confluence page (storage-format body).
 * Write — Write-approval upstream. Never throws.
 */
export async function confluenceCreatePage(
  conn: AtlassianConn,
  input: { spaceKey: string; title: string; body: string },
): Promise<AtlassianResult<ConfluencePage>> {
  if (!input.spaceKey.trim() || !input.title.trim()) return { ok: false, reason: 'confluence_create_page needs a spaceKey and a title' };
  const r = await atlWrite(conn, 'POST', '/wiki/rest/api/content', {
    type: 'page',
    title: input.title,
    space: { key: input.spaceKey },
    body: { storage: { value: `<p>${(input.body ?? '').replace(/</g, '&lt;')}</p>`, representation: 'storage' } },
  });
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return { ok: true, data: { id: String(d.id ?? ''), title: input.title, url: String(((d._links as { webui?: string })?.webui) ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure client config from a resolved `atlassian` connection. The secret is
 *  dereferenced from the vault HERE and never leaves the server. Bearer vs Basic is
 *  read from the non-secret `atlassian` config; default Basic (API-token) with email. */
export function atlassianConnFrom(c: Connection): AtlassianConn {
  const cfg = c.atlassian;
  return {
    baseUrl: c.endpoint,
    authKind: cfg?.authKind ?? 'basic',
    email: cfg?.email,
    secret: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}

/** Resolve an `atlassian` connection the caller may see. 404 for an unseeable id; 400 wrong type. */
export async function resolveAtlassian(connId: string, user: CurrentUser): Promise<Connection> {
  const c = await getConnectionForUser(connId, user); // DLS guard (404)
  if (c.template !== 'atlassian') {
    const e = new Error('Not an Atlassian connection') as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return c;
}
