/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
// getSecretServerSide is imported for parity with peer connectors (slack/github). For
// notion-mcp the raw access token is stored as an OAuth token-set via storeNotionConnection;
// the token is resolved from the vault by `store.ts:notionConnFor` (readTokens) before
// being injected here — the raw value NEVER leaves the server boundary.
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Notion REST client (`https://api.notion.com/v1`) — the REAL execution surface for
 * the `notion-mcp` connector, using the OAuth access token the hosted-MCP connect
 * flow already stored (see `lib/oauth/notion-mcp.ts` + `storeNotionConnection`). It
 * COMPLETES an already-user-visible connector whose `notion_search` / `notion_get_page`
 * previously returned `executeMock` fixtures.
 *
 * Governance is enforced UPSTREAM in `callConnectionTool` (reads auto · `notion_create_page`
 * Write-approval · delete Blocked) — a helper here is only reached once allowed.
 *
 * Same discipline as `airflow.ts`/`github.ts`/`slack.ts`:
 *  • `fetch` injected, the token injected as an ARG (never logged/returned).
 *  • Every call NEVER throws — `{ ok:false, reason }`.
 *  • `429` + `Retry-After`: capped exponential backoff with jitter (one retry) on POST
 *    writes; honest reason surfaced on reads, never hammer.
 *  • Cursor pagination (`has_more` + `next_cursor`): followed up to `NOTION_MAX_PAGES`
 *    with a `truncated` flag when more remains (§5 bounded pagination).
 *  • Real liveness probe (`notionHealth`) via `GET /v1/users/me`: honest ✗ on failure,
 *    never fakes green.
 */

export type NotionFetch = typeof fetch;

export const NOTION_API = 'https://api.notion.com/v1';
/** The Notion API version header (pinned; the API is versioned by date). */
export const NOTION_VERSION = '2022-06-28';
/** Max cursor pages to follow on a paginated search before flagging `truncated`. */
export const NOTION_MAX_PAGES = 5;
/** Per-page size requested from the API. */
export const NOTION_PAGE_SIZE = 25;

export type NotionConn = {
  baseUrl: string;
  /** The user's Notion OAuth access token (resolved from the vault). */
  token?: string;
  fetchImpl: NotionFetch;
  timeoutMs?: number;
};

export type NotionResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

/**
 * Auth headers. The token is used ONLY to build the Authorization header; never
 * returned or logged. Absent token ⇒ no header (honest auth fail, not a broken one).
 */
export function notionAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json', 'notion-version': NOTION_VERSION };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: NotionConn): string {
  return (conn.baseUrl || NOTION_API).replace(/\/$/, '');
}

/** Honest reason for a rate-limited response; never hammer (surface the hint). */
function rateReason(res: Response): string | null {
  if (res.status === 429) return `rate-limited; retry after ${res.headers.get('retry-after') ?? '60'}s`;
  return null;
}

async function withTimeout(conn: NotionConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Notion API call. Never throws — a non-OK status or a network error becomes an
 * honest reason. On POST writes, a single capped backoff-with-jitter retry runs on a
 * 429 (§5 rate-limit discipline; reads surface the rate-limit reason and return).
 */
async function nSend(
  conn: NotionConn,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<NotionResult<unknown>> {
  const headers: Record<string, string> = {
    ...notionAuthHeaders(conn.token),
    ...(body ? { 'content-type': 'application/json' } : {}),
  };
  const maxAttempts = method === 'POST' ? 2 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const init: RequestInit = { method, headers };
      if (body) init.body = JSON.stringify(body);
      const res = await withTimeout(conn, `${base(conn)}${path}`, init);
      if (res.status === 429 && attempt === 0 && method === 'POST') {
        // Capped exponential backoff with FULL JITTER (§5) — one retry, never hammer.
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        const capped = Math.min(retryAfter, 5);
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * capped * 1000)));
        continue;
      }
      const rl = rateReason(res);
      if (rl) return { ok: false, reason: rl };
      if (res.status === 401) return { ok: false, reason: 'unauthorized (reconnect Notion)' };
      if (res.status === 403) return { ok: false, reason: 'forbidden (insufficient Notion permissions)' };
      if (res.status === 404) return { ok: false, reason: 'not_found' };
      if (!res.ok) return { ok: false, reason: `Notion ${res.status}` };
      return { ok: true, data: await res.json().catch(() => ({})) };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: false, reason: 'rate-limited; retry later' };
}

// --------------------------------------------------------------- liveness -------

/**
 * Liveness probe: GET /v1/users/me (the authenticated Notion bot/user). ANY 2xx proves
 * the token is live and the integration has access; a 401 means the token is bad or
 * revoked (honest ✗, not a fake green); a network error means genuinely unreachable.
 * The token is used ONLY as the bearer — never returned or logged.
 */
export async function notionHealth(
  conn: NotionConn,
): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  try {
    const res = await withTimeout(conn, `${base(conn)}/users/me`, {
      method: 'GET',
      headers: notionAuthHeaders(conn.token),
    });
    if (res.status === 401) return { connected: false, reason: 'unauthorized (bad or missing token — reconnect Notion)' };
    const rl = rateReason(res);
    if (rl) return { connected: false, reason: rl };
    if (!res.ok) return { connected: false, reason: `Notion ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { name?: string; type?: string };
    const who = j.name ?? j.type ?? '';
    return { connected: true, detail: who ? `authenticated as ${who}` : undefined };
  } catch {
    return { connected: false, reason: 'unreachable' };
  }
}

// --------------------------------------------------------- helpers ---------------

/** Best-effort plain-text title from a Notion page's `properties` (title property). */
export function pageTitle(page: Record<string, unknown>): string {
  const props = (page.properties ?? {}) as Record<string, unknown>;
  for (const v of Object.values(props)) {
    const prop = v as { type?: string; title?: { plain_text?: string }[] };
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? '').join('') || '(untitled)';
    }
  }
  return '(untitled)';
}

export type NotionSearchHit = { id: string; title: string; url: string; object: string };
export type NotionPage = { id: string; title: string; url: string };

// ------------------------------------------------------------- reads (auto) -----

/**
 * POST /search — search pages + databases the token can see. Cursor-paginated: follows
 * `has_more` + `next_cursor` up to `NOTION_MAX_PAGES`, then sets `truncated`. Read.
 * Never throws.
 */
export async function notionSearch(
  conn: NotionConn,
  query: string,
): Promise<NotionResult<NotionSearchHit[]>> {
  const rows: NotionSearchHit[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const reqBody: Record<string, unknown> = { query, page_size: NOTION_PAGE_SIZE };
    if (cursor) reqBody.start_cursor = cursor;
    const r = await nSend(conn, 'POST', '/search', reqBody);
    if (!r.ok) {
      // Return whatever rows we already accumulated, or propagate the error on page 1.
      if (pages === 0) return r;
      break;
    }
    const body = r.data as { results?: Record<string, unknown>[]; has_more?: boolean; next_cursor?: string | null };
    for (const d of body.results ?? []) {
      rows.push({
        id: String(d.id ?? ''),
        title: pageTitle(d),
        url: String(d.url ?? ''),
        object: String(d.object ?? ''),
      });
    }
    pages += 1;
    if (body.has_more && body.next_cursor) {
      if (pages >= NOTION_MAX_PAGES) { truncated = true; break; }
      cursor = body.next_cursor;
    } else {
      cursor = undefined;
    }
  } while (cursor);

  return { ok: true, data: rows, truncated };
}

/** GET /pages/{id} — read one page's metadata. Read. Never throws. */
export async function notionGetPage(conn: NotionConn, id: string): Promise<NotionResult<NotionPage>> {
  if (!id.trim()) return { ok: false, reason: 'notion_get_page needs a page id' };
  const r = await nSend(conn, 'GET', `/pages/${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return { ok: true, data: { id: String(d.id ?? id), title: pageTitle(d), url: String(d.url ?? '') } };
}

// ---------------------------------------------- writes (Write-approval) ---------

/**
 * POST /pages — create a page under a parent page. Write — Write-approval upstream.
 * Never throws. `text` becomes a single paragraph block. A single capped-backoff
 * retry runs on a 429 (§5 rate-limit + jitter; already wired in `nSend` for POST).
 */
export async function notionCreatePage(
  conn: NotionConn,
  input: { parentId: string; title: string; text?: string },
): Promise<NotionResult<NotionPage>> {
  if (!input.parentId.trim()) return { ok: false, reason: 'notion_create_page needs a parentId' };
  if (!input.title.trim()) return { ok: false, reason: 'notion_create_page needs a title' };
  const body: Record<string, unknown> = {
    parent: { page_id: input.parentId },
    properties: { title: { title: [{ text: { content: input.title } }] } },
  };
  if (input.text && input.text.trim()) {
    body.children = [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: input.text } }] } }];
  }
  const r = await nSend(conn, 'POST', '/pages', body);
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return { ok: true, data: { id: String(d.id ?? ''), title: input.title, url: String(d.url ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/**
 * Build the pure Notion client config. The OAuth access token for notion-mcp is stored
 * as a token-set (not a simple secret key) and is resolved from the vault by the CALLER
 * (`store.ts:notionConnFor` → `readTokens(c.secretRef)?.accessToken`) before being
 * injected here. For service-credential notion connections `getSecretServerSide` is
 * available via the import at the top of this module. The raw value NEVER leaves the
 * server in either path.
 */
export function notionConnFrom(c: Connection, accessToken?: string): NotionConn {
  // For non-OAuth notion connections (service-credential style), the caller may omit
  // accessToken and let us resolve it from the secretRef directly.
  const token = accessToken ?? getSecretServerSide(c.secretRef) ?? undefined;
  return {
    baseUrl: NOTION_API,
    token,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
