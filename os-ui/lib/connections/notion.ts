/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';

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
 * Discipline as `airflow.ts`/`github.ts`: `fetch` injected, the token injected as an
 * ARG (never logged/returned), and every call NEVER throws — `{ ok:false, reason }`.
 * Respects `429` + `Retry-After` (honest reason, no hammer).
 */

export type NotionFetch = typeof fetch;

export const NOTION_API = 'https://api.notion.com/v1';
/** The Notion API version header (pinned; the API is versioned by date). */
export const NOTION_VERSION = '2022-06-28';

export type NotionConn = {
  baseUrl: string;
  /** The user's Notion OAuth access token (resolved from the vault). */
  token?: string;
  fetchImpl: NotionFetch;
  timeoutMs?: number;
};

export type NotionResult<T> =
  | { ok: true; data: T }
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

async function nSend(
  conn: NotionConn,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<NotionResult<unknown>> {
  try {
    const init: RequestInit = { method, headers: { ...notionAuthHeaders(conn.token), ...(body ? { 'content-type': 'application/json' } : {}) } };
    if (body) init.body = JSON.stringify(body);
    const res = await withTimeout(conn, `${base(conn)}${path}`, init);
    const rl = rateReason(res);
    if (rl) return { ok: false, reason: rl };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (reconnect Notion)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Notion ${res.status}` };
    return { ok: true, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

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

/** POST /search — search pages + databases the token can see. Read. */
export async function notionSearch(conn: NotionConn, query: string): Promise<NotionResult<NotionSearchHit[]>> {
  const r = await nSend(conn, 'POST', '/search', { query, page_size: 25 });
  if (!r.ok) return r;
  const rows = ((r.data as { results?: Record<string, unknown>[] })?.results) ?? [];
  return {
    ok: true,
    data: rows.map((d) => ({
      id: String(d.id ?? ''),
      title: pageTitle(d),
      url: String(d.url ?? ''),
      object: String(d.object ?? ''),
    })),
  };
}

/** GET /pages/{id} — read one page's metadata. Read. */
export async function notionGetPage(conn: NotionConn, id: string): Promise<NotionResult<NotionPage>> {
  if (!id.trim()) return { ok: false, reason: 'notion_get_page needs a page id' };
  const r = await nSend(conn, 'GET', `/pages/${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return { ok: true, data: { id: String(d.id ?? id), title: pageTitle(d), url: String(d.url ?? '') } };
}

/**
 * POST /pages — create a page under a parent page. Write — Write-approval upstream.
 * Never throws. `text` becomes a single paragraph block.
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

/** Build the pure Notion client config. The OAuth access token is dereferenced from
 *  the vault by the CALLER and passed in HERE; it never leaves the server. */
export function notionConnFrom(c: Connection, accessToken?: string): NotionConn {
  return {
    baseUrl: NOTION_API,
    token: accessToken,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
