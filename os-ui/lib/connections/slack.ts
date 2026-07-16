/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Slack Web API client (`https://slack.com/api`) — the per-connection bridge to a
 * customer's Slack workspace via a bot token (`xoxb-…`).
 *
 * A governed OUTBOUND connection: OS agents read channels/users/messages and
 * (approval-gated) post a message through the SAME capability gate every other
 * connection tool passes. This module is the PURE, testable client (`fetch`
 * injected, the token injected as an ARG, never logged/returned) plus a thin
 * SERVER-SIDE bridge that dereferences the vaulted bot token HERE.
 *
 * Same discipline as `airflow.ts`/`github.ts`: every call NEVER throws — it
 * degrades to `{ ok:false, reason }` so honest errors surface without crashing.
 *
 * QUIRKS handled (per CONNECTOR-STANDARD §5):
 *  • Slack returns HTTP 200 even on API errors — the real status is the JSON
 *    `{ ok:false, error }` body. We map `ok:false` to an honest reason, and the
 *    Tier-based `ratelimited` error (with `Retry-After`) to a `rate-limited` reason
 *    without hammering.
 *  • Pagination — cursor-based (`response_metadata.next_cursor`) is followed up to a
 *    bounded page count, with a `truncated` flag when more remains.
 */

export type SlackFetch = typeof fetch;

export const SLACK_API = 'https://slack.com/api';
/** Max cursor pages to follow on a paginated read before flagging `truncated`. */
export const SLACK_MAX_PAGES = 5;
/** Per-page size requested from the API. */
export const SLACK_PER_PAGE = 100;

/** A per-connection Slack client config: where + the bot token. */
export type SlackConn = {
  baseUrl: string;
  /** The bot token `xoxb-…` (resolved from the vault). Absent ⇒ calls honestly fail auth. */
  token?: string;
  fetchImpl: SlackFetch;
  timeoutMs?: number;
};

export type SlackResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

/**
 * Build the auth headers. The token is used ONLY to construct the Authorization
 * header; it is never returned or logged. Absent token ⇒ no header (honest auth fail).
 */
export function slackAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: SlackConn): string {
  return (conn.baseUrl || SLACK_API).replace(/\/$/, '');
}

async function withTimeout(conn: SlackConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a Slack API error string to an honest reason. Slack signals errors in the
 * JSON body (`ok:false`), NOT the HTTP status — `not_found`-style errors must not be
 * fabricated. `ratelimited` carries a `Retry-After` header we surface (no hammer).
 */
function slackErrorReason(error: string, retryAfter?: string | null): string {
  if (error === 'ratelimited') return `rate-limited; retry after ${retryAfter ?? '30'}s`;
  if (error === 'channel_not_found' || error === 'user_not_found' || error === 'message_not_found') return 'not_found';
  if (error === 'invalid_auth' || error === 'not_authed' || error === 'token_revoked' || error === 'account_inactive') {
    return 'unauthorized (bad or missing bot token)';
  }
  if (error === 'missing_scope' || error === 'not_allowed_token_type') return `missing scope (${error})`;
  return `Slack error: ${error}`;
}

/** One Slack Web API call as JSON. Never throws. Maps Slack's `ok:false` body + 429. */
async function slackCall(
  conn: SlackConn,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string>,
): Promise<SlackResult<Record<string, unknown>>> {
  const url = `${base(conn)}/${path}`;
  try {
    let res: Response;
    if (method === 'GET') {
      const qs = new URLSearchParams(params).toString();
      res = await withTimeout(conn, qs ? `${url}?${qs}` : url, { method: 'GET', headers: slackAuthHeaders(conn.token) });
    } else {
      res = await withTimeout(conn, url, {
        method: 'POST',
        headers: { ...slackAuthHeaders(conn.token), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
    }
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (!res.ok) return { ok: false, reason: `Slack ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.ok !== true) return { ok: false, reason: slackErrorReason(String(body.error ?? 'unknown'), res.headers.get('retry-after')) };
    return { ok: true, data: body };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * A cursor-paginated read. Follows `response_metadata.next_cursor` up to
 * `SLACK_MAX_PAGES`, concatenating `body[listKey]`. Sets `truncated` when more
 * pages remain. Never throws.
 */
async function slackPaged(
  conn: SlackConn,
  path: string,
  params: Record<string, string>,
  listKey: string,
): Promise<SlackResult<Record<string, unknown>[]>> {
  const rows: Record<string, unknown>[] = [];
  let cursor = '';
  let pages = 0;
  let truncated = false;
  do {
    const page = await slackCall(conn, 'GET', path, { ...params, limit: String(SLACK_PER_PAGE), ...(cursor ? { cursor } : {}) });
    if (!page.ok) return page;
    const list = page.data[listKey];
    if (Array.isArray(list)) for (const r of list) rows.push(r as Record<string, unknown>);
    const meta = (page.data.response_metadata ?? {}) as { next_cursor?: string };
    cursor = String(meta.next_cursor ?? '');
    pages += 1;
    if (cursor && pages >= SLACK_MAX_PAGES) { truncated = true; break; }
  } while (cursor);
  return { ok: true, data: rows, truncated };
}

// --------------------------------------------------------------- liveness -------

/**
 * Liveness probe: `auth.test` (the authenticated bot). `ok:true` proves the token is
 * live; an `invalid_auth` body is an honest ✗ (never a fake green); a network error
 * means genuinely unreachable. The token is used ONLY as the bearer — never returned.
 */
export async function slackHealth(
  conn: SlackConn,
): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await slackCall(conn, 'GET', 'auth.test', {});
  if (r.ok) {
    const team = String(r.data.team ?? '');
    const user = String(r.data.user ?? '');
    return { connected: true, detail: team || user ? `authenticated as ${user || 'bot'} on ${team || 'workspace'}` : undefined };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type SlackChannel = { id: string; name: string; isPrivate: boolean; members: number };
export type SlackUser = { id: string; name: string; realName: string; isBot: boolean };
export type SlackMessage = { user: string; text: string; ts: string };

function shapeChannel(d: Record<string, unknown>): SlackChannel {
  return {
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    isPrivate: Boolean(d.is_private),
    members: Number(d.num_members ?? 0),
  };
}
function shapeUser(d: Record<string, unknown>): SlackUser {
  return {
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    realName: String((d.profile as { real_name?: string })?.real_name ?? d.real_name ?? ''),
    isBot: Boolean(d.is_bot),
  };
}
function shapeMessage(d: Record<string, unknown>): SlackMessage {
  return { user: String(d.user ?? d.bot_id ?? ''), text: String(d.text ?? ''), ts: String(d.ts ?? '') };
}

/** GET conversations.list — list channels the bot can see. Read. */
export async function listChannels(conn: SlackConn): Promise<SlackResult<SlackChannel[]>> {
  const r = await slackPaged(conn, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true' }, 'channels');
  if (!r.ok) return r;
  return { ok: true, data: r.data.map(shapeChannel), truncated: r.truncated };
}

/** GET users.list — list workspace users. Read. */
export async function listUsers(conn: SlackConn): Promise<SlackResult<SlackUser[]>> {
  const r = await slackPaged(conn, 'users.list', {}, 'members');
  if (!r.ok) return r;
  return { ok: true, data: r.data.map(shapeUser), truncated: r.truncated };
}

/** GET conversations.history — read recent messages in a channel. Read. */
export async function conversationsHistory(
  conn: SlackConn,
  channel: string,
  opts?: { limit?: number },
): Promise<SlackResult<SlackMessage[]>> {
  if (!channel.trim()) return { ok: false, reason: 'conversations_history needs a channel id' };
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), SLACK_PER_PAGE);
  const r = await slackCall(conn, 'GET', 'conversations.history', { channel, limit: String(limit) });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.messages) ? (r.data.messages as Record<string, unknown>[]).map(shapeMessage) : [];
  return { ok: true, data: rows };
}

// ---------------------------------------------- writes (Write-approval) ---------

/**
 * POST chat.postMessage — post a message to a channel. Write — Write-approval
 * upstream (never auto-post). Never throws. Returns the posted message ts.
 */
export async function postMessage(
  conn: SlackConn,
  input: { channel: string; text: string },
): Promise<SlackResult<{ channel: string; ts: string }>> {
  if (!input.channel.trim()) return { ok: false, reason: 'post_message needs a channel' };
  if (!input.text.trim()) return { ok: false, reason: 'post_message needs text' };
  const r = await slackCall(conn, 'POST', 'chat.postMessage', { channel: input.channel, text: input.text });
  if (!r.ok) return r;
  return { ok: true, data: { channel: String(r.data.channel ?? input.channel), ts: String(r.data.ts ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure client config from a resolved `slack` connection. The bot token is
 *  dereferenced from the vault HERE and never leaves the server. */
export function slackConnFrom(c: Connection): SlackConn {
  return {
    baseUrl: c.endpoint || SLACK_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
