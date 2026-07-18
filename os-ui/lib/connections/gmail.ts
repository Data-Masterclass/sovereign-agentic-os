/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { fetchWithBackoff } from '@/lib/connections/retry';

/**
 * Gmail API client (`https://gmail.googleapis.com`) — the per-connection bridge to a
 * customer's Gmail mailbox via a Google OAuth 2.0 access token.
 *
 * A governed OUTBOUND connection: OS agents read messages/labels and (approval-gated)
 * send or draft mail through the SAME capability gate every other connection tool
 * passes. This module is the PURE, testable client (`fetch` injected, the token
 * injected as an ARG, never logged/returned) plus a thin SERVER-SIDE bridge that
 * dereferences the vaulted OAuth access token HERE.
 *
 * Same discipline as `github.ts`: every call NEVER throws — it degrades to
 * `{ ok:false, reason }`. Respects `429` + `Retry-After` (honest reason, no hammer).
 *
 * TOKEN NOTE (§5 auth): a pasted OAuth access token is short-lived (~1h). Automatic
 * refresh-token rotation is a documented follow-up; a 401 is surfaced honestly so the
 * user knows to refresh + re-test, and is never faked green.
 */

export type GmailFetch = typeof fetch;

export const GMAIL_API = 'https://gmail.googleapis.com';
/** Per-page size requested from the API (bounded — never an unbounded dump). */
export const GMAIL_PAGE = 25;
/** Max pages to follow on nextPageToken before flagging `truncated`. */
export const GMAIL_MAX_PAGES = 4;

export type GmailConn = {
  baseUrl: string;
  /** The Google OAuth access token (resolved from the vault). Absent ⇒ honest auth fail. */
  token?: string;
  fetchImpl: GmailFetch;
  timeoutMs?: number;
};

export type GmailResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

/** Auth headers. The token is used ONLY to build the Authorization header; never returned/logged. */
export function gmailAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: GmailConn): string {
  return (conn.baseUrl || GMAIL_API).replace(/\/$/, '');
}

async function withTimeout(conn: GmailConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

function mapGmailResponse(res: Response): GmailResult<Record<string, unknown>> | null {
  if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
  if (res.status === 401) return { ok: false, reason: 'unauthorized (access token expired or invalid — refresh it)' };
  if (res.status === 403) return { ok: false, reason: 'forbidden (missing Gmail scope)' };
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) return { ok: false, reason: `Gmail ${res.status}` };
  return null;
}

/** GET — no retry (429 surfaces immediately as honest reason). */
async function gGet(conn: GmailConn, path: string): Promise<GmailResult<Record<string, unknown>>> {
  try {
    const res = await withTimeout(conn, `${base(conn)}${path}`, { method: 'GET', headers: gmailAuthHeaders(conn.token) });
    const err = mapGmailResponse(res);
    if (err) return err;
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** POST — capped exponential backoff with jitter on 429/503 (one retry). */
async function gPost(conn: GmailConn, path: string, body: Record<string, unknown>): Promise<GmailResult<Record<string, unknown>>> {
  try {
    const init: RequestInit = { method: 'POST', headers: { ...gmailAuthHeaders(conn.token), 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetchWithBackoff(`${base(conn)}${path}`, init, (u, i) => withTimeout(conn, u, i!), { maxAttempts: 2 });
    const err = mapGmailResponse(res);
    if (err) return err;
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** Base64url-encode a UTF-8 string (RFC822 raw message). No secret involved. */
export function base64UrlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a minimal RFC822 message. `to`/`subject` are validated by the caller. */
export function buildRawMessage(input: { to: string; subject: string; body: string }): string {
  const headers = [`To: ${input.to}`, `Subject: ${input.subject}`, 'Content-Type: text/plain; charset="UTF-8"', 'MIME-Version: 1.0'];
  return base64UrlEncode(`${headers.join('\r\n')}\r\n\r\n${input.body}`);
}

// --------------------------------------------------------------- liveness -------

/** Liveness: GET /users/me/profile. 2xx ⇒ live; 401 ⇒ honest ✗ (never fake green). */
export async function gmailHealth(conn: GmailConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await gGet(conn, '/gmail/v1/users/me/profile');
  if (r.ok) {
    const email = String(r.data.emailAddress ?? '');
    return { connected: true, detail: email ? `mailbox ${email}` : undefined };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type GmailMessageRef = { id: string; threadId: string };
export type GmailMessage = { id: string; threadId: string; snippet: string; from: string; subject: string };
export type GmailLabel = { id: string; name: string; type: string };

function headerVal(payload: Record<string, unknown>, name: string): string {
  const headers = ((payload?.headers ?? []) as { name?: string; value?: string }[]);
  const h = headers.find((x) => (x.name ?? '').toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/** GET /users/me/messages — list message ids (optionally by query). Read.
 *  Follows `nextPageToken` cursor up to `GMAIL_MAX_PAGES` pages. */
export async function gmailListMessages(conn: GmailConn, opts?: { query?: string }): Promise<GmailResult<GmailMessageRef[]>> {
  const refs: GmailMessageRef[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let truncated = false;
  while (pages < GMAIL_MAX_PAGES) {
    const params: Record<string, string> = { maxResults: String(GMAIL_PAGE), ...(opts?.query ? { q: opts.query } : {}) };
    if (pageToken) params.pageToken = pageToken;
    const qs = new URLSearchParams(params).toString();
    const r = await gGet(conn, `/gmail/v1/users/me/messages?${qs}`);
    if (!r.ok) return r;
    const page = Array.isArray(r.data.messages) ? (r.data.messages as Record<string, unknown>[]) : [];
    for (const d of page) refs.push({ id: String(d.id ?? ''), threadId: String(d.threadId ?? '') });
    pages += 1;
    pageToken = r.data.nextPageToken ? String(r.data.nextPageToken) : undefined;
    if (!pageToken) break;
    if (pages >= GMAIL_MAX_PAGES) { truncated = true; break; }
  }
  return { ok: true, data: refs, truncated };
}

/** GET /users/me/messages/{id} — read one message (metadata + snippet). Read. */
export async function gmailGetMessage(conn: GmailConn, id: string): Promise<GmailResult<GmailMessage>> {
  if (!id.trim()) return { ok: false, reason: 'get_message needs a message id' };
  const r = await gGet(conn, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
  if (!r.ok) return r;
  const payload = (r.data.payload ?? {}) as Record<string, unknown>;
  return { ok: true, data: { id: String(r.data.id ?? id), threadId: String(r.data.threadId ?? ''), snippet: String(r.data.snippet ?? ''), from: headerVal(payload, 'From'), subject: headerVal(payload, 'Subject') } };
}

/** GET /users/me/labels — list mailbox labels. Read. */
export async function gmailListLabels(conn: GmailConn): Promise<GmailResult<GmailLabel[]>> {
  const r = await gGet(conn, '/gmail/v1/users/me/labels');
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.labels) ? (r.data.labels as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map((d) => ({ id: String(d.id ?? ''), name: String(d.name ?? ''), type: String(d.type ?? '') })) };
}

// ---------------------------------------------- writes (Write-approval) ---------

/**
 * POST /users/me/messages/send — send an email. Write — Write-approval upstream;
 * NEVER auto-sent. Never throws. Validates recipient + subject before the network.
 */
export async function gmailSendMessage(conn: GmailConn, input: { to: string; subject: string; body: string }): Promise<GmailResult<{ id: string; threadId: string }>> {
  if (!input.to.trim()) return { ok: false, reason: 'send_message needs a recipient (to)' };
  if (!input.subject.trim()) return { ok: false, reason: 'send_message needs a subject' };
  const r = await gPost(conn, '/gmail/v1/users/me/messages/send', { raw: buildRawMessage(input) });
  if (!r.ok) return r;
  return { ok: true, data: { id: String(r.data.id ?? ''), threadId: String(r.data.threadId ?? '') } };
}

/**
 * POST /users/me/drafts — create a draft (does NOT send). Write — Write-approval
 * upstream. Never throws.
 */
export async function gmailCreateDraft(conn: GmailConn, input: { to: string; subject: string; body: string }): Promise<GmailResult<{ id: string }>> {
  if (!input.to.trim()) return { ok: false, reason: 'create_draft needs a recipient (to)' };
  const r = await gPost(conn, '/gmail/v1/users/me/drafts', { message: { raw: buildRawMessage(input) } });
  if (!r.ok) return r;
  return { ok: true, data: { id: String(r.data.id ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Gmail client config — the OAuth access token is dereferenced from
 *  the vault HERE (server-side) and never leaves this process. */
export function googleMailConnFrom(c: Connection): GmailConn {
  return {
    baseUrl: c.endpoint || GMAIL_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
