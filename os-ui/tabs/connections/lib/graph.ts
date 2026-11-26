/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The shared Microsoft Graph transport for the pasted-token Graph connectors (Teams, Entra ID)
 * USER STORY: As a maintainer I want one Graph client — headers, timeout, honest 401/403/404/429 mapping,
 *             nextLink paging limits — so each Microsoft connector shapes only its own data.
 * ARCHITECTURE:
 *   - Pure and testable: `fetch` and the token are injected through `GraphConn`; the token is used only as
 *     the bearer and is never logged or returned.
 *   - `graphSend` never throws: every failure is `{ ok:false, reason }`. GET surfaces a 429 at once; a POST or
 *     PATCH retries a 429/503 once through the shared capped backoff (`retry.ts`).
 *   - A 2xx body that is not JSON is a failure, never an empty object.
 *   - Moved here from the retired `outlook.ts` (the Outlook mail tools now live on the Microsoft 365 account
 *     connection, `account-tools.ts`).
 */
import { fetchWithBackoff } from '@tabs/connections/lib/retry';

export type GraphFetch = typeof fetch;

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
export const GRAPH_PAGE = 25;
/** Max pages to follow on @odata.nextLink before flagging `truncated`. */
export const GRAPH_MAX_PAGES = 4;

export type GraphConn = {
  baseUrl: string;
  token?: string;
  fetchImpl: GraphFetch;
  timeoutMs?: number;
};

export type GraphResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

export function graphAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: GraphConn): string {
  return (conn.baseUrl || GRAPH_API).replace(/\/$/, '');
}

async function withTimeout(conn: GraphConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

function mapGraphResponse(res: Response): GraphResult<Record<string, unknown>> | null {
  if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
  if (res.status === 401) return { ok: false, reason: 'unauthorized (access token expired or invalid — refresh it)' };
  if (res.status === 403) return { ok: false, reason: 'forbidden (missing Graph scope)' };
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) return { ok: false, reason: `Graph ${res.status}` };
  return null;
}

/** A 2xx body: empty (202/204 or no content) is `{}`; JSON is parsed; anything else is a failure. */
async function readBody(res: Response): Promise<GraphResult<Record<string, unknown>>> {
  if (res.status === 202 || res.status === 204) return { ok: true, data: {} };
  const text = await res.text();
  if (!text.trim()) return { ok: true, data: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Graph answered with a body that is not JSON' };
  }
  return { ok: true, data: value && typeof value === 'object' ? (value as Record<string, unknown>) : {} };
}

/**
 * One Microsoft Graph call. Never throws. Maps 401/403/404/429 to honest reasons.
 * GET requests surface 429 immediately (no retry). POST/PATCH uses capped exponential
 * backoff with jitter on 429/503 via the shared retry helper.
 * `path` may be a full nextLink URL (starts with https) or a relative API path.
 */
export async function graphSend(
  conn: GraphConn,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<GraphResult<Record<string, unknown>>> {
  try {
    const url = path.startsWith('https') ? path : `${base(conn)}${path}`;
    const init: RequestInit = { method, headers: { ...graphAuthHeaders(conn.token), ...(body ? { 'content-type': 'application/json' } : {}) } };
    if (body) init.body = JSON.stringify(body);
    let res: Response;
    if (method === 'GET') {
      res = await withTimeout(conn, url, init);
    } else {
      res = await fetchWithBackoff(url, init, (u, i) => withTimeout(conn, u, i!), { maxAttempts: 2 });
    }
    const err = mapGraphResponse(res);
    if (err) return err;
    return await readBody(res);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
