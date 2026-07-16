/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Outlook mail client over Microsoft Graph (`https://graph.microsoft.com/v1.0`) —
 * the per-connection bridge to a customer's Outlook mailbox via a Microsoft OAuth 2.0
 * access token.
 *
 * A governed OUTBOUND connection: OS agents read mail and (approval-gated) send or
 * draft mail through the SAME capability gate. Pure, testable client (`fetch`
 * injected, token injected as an ARG, never logged/returned) + a thin SERVER-SIDE
 * bridge that dereferences the vaulted token HERE.
 *
 * Same discipline as `github.ts`: every call NEVER throws — `{ ok:false, reason }`.
 * A short-lived token that 401s is surfaced honestly; refresh-token rotation is a
 * documented follow-up.
 */

export type GraphFetch = typeof fetch;

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
export const GRAPH_PAGE = 25;

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

/** One Microsoft Graph call. Never throws. Maps 401/403/404/429 to honest reasons. */
export async function graphSend(
  conn: GraphConn,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<GraphResult<Record<string, unknown>>> {
  try {
    const init: RequestInit = { method, headers: { ...graphAuthHeaders(conn.token), ...(body ? { 'content-type': 'application/json' } : {}) } };
    if (body) init.body = JSON.stringify(body);
    const res = await withTimeout(conn, `${base(conn)}${path}`, init);
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (access token expired or invalid — refresh it)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (missing Graph scope)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Graph ${res.status}` };
    // 202 Accepted (sendMail) has no body.
    if (res.status === 202 || res.status === 204) return { ok: true, data: {} };
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** A Graph message body envelope (used by send + draft). Plain-text content. */
export function graphMessageBody(input: { to: string; subject: string; body: string }): Record<string, unknown> {
  return {
    subject: input.subject,
    body: { contentType: 'Text', content: input.body },
    toRecipients: [{ emailAddress: { address: input.to } }],
  };
}

// --------------------------------------------------------------- liveness -------

/** Liveness: GET /me. 2xx ⇒ live; 401 ⇒ honest ✗ (never fake green). */
export async function outlookHealth(conn: GraphConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await graphSend(conn, 'GET', '/me');
  if (r.ok) {
    const mail = String(r.data.mail ?? r.data.userPrincipalName ?? '');
    return { connected: true, detail: mail ? `mailbox ${mail}` : undefined };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type OutlookMessage = { id: string; subject: string; from: string; received: string; preview: string };

function shapeMessage(d: Record<string, unknown>): OutlookMessage {
  const from = (d.from ?? {}) as { emailAddress?: { address?: string } };
  return {
    id: String(d.id ?? ''),
    subject: String(d.subject ?? ''),
    from: String(from.emailAddress?.address ?? ''),
    received: String(d.receivedDateTime ?? ''),
    preview: String(d.bodyPreview ?? ''),
  };
}

/** GET /me/messages — list mail (optionally $search). Read. Bounded. */
export async function outlookListMessages(conn: GraphConn, opts?: { search?: string }): Promise<GraphResult<OutlookMessage[]>> {
  const params: Record<string, string> = { $top: String(GRAPH_PAGE), $select: 'id,subject,from,receivedDateTime,bodyPreview' };
  if (opts?.search) params.$search = `"${opts.search}"`;
  const qs = new URLSearchParams(params).toString();
  const r = await graphSend(conn, 'GET', `/me/messages?${qs}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.value) ? (r.data.value as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map(shapeMessage), truncated: Boolean(r.data['@odata.nextLink']) };
}

/** GET /me/messages/{id} — read one message. Read. */
export async function outlookGetMessage(conn: GraphConn, id: string): Promise<GraphResult<OutlookMessage>> {
  if (!id.trim()) return { ok: false, reason: 'get_message needs a message id' };
  const r = await graphSend(conn, 'GET', `/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,receivedDateTime,bodyPreview`);
  if (!r.ok) return r;
  return { ok: true, data: shapeMessage(r.data) };
}

// ---------------------------------------------- writes (Write-approval) ---------

/**
 * POST /me/sendMail — send an email. Write — Write-approval upstream; NEVER
 * auto-sent. Never throws. Validates recipient + subject before the network.
 */
export async function outlookSendMail(conn: GraphConn, input: { to: string; subject: string; body: string }): Promise<GraphResult<{ sent: true }>> {
  if (!input.to.trim()) return { ok: false, reason: 'send_mail needs a recipient (to)' };
  if (!input.subject.trim()) return { ok: false, reason: 'send_mail needs a subject' };
  const r = await graphSend(conn, 'POST', '/me/sendMail', { message: graphMessageBody(input), saveToSentItems: true });
  if (!r.ok) return r;
  return { ok: true, data: { sent: true } };
}

/** POST /me/messages — create a draft (does NOT send). Write — Write-approval upstream. */
export async function outlookCreateDraft(conn: GraphConn, input: { to: string; subject: string; body: string }): Promise<GraphResult<{ id: string }>> {
  if (!input.to.trim()) return { ok: false, reason: 'create_draft needs a recipient (to)' };
  const r = await graphSend(conn, 'POST', '/me/messages', graphMessageBody(input));
  if (!r.ok) return r;
  return { ok: true, data: { id: String(r.data.id ?? '') } };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Graph client config — the OAuth access token is dereferenced from
 *  the vault HERE (server-side) and never leaves this process. */
export function graphConnFrom(c: Connection): GraphConn {
  return {
    baseUrl: c.endpoint || GRAPH_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
