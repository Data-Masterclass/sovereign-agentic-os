/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';

/**
 * Google Calendar API client (`https://www.googleapis.com/calendar/v3`) — the
 * per-connection bridge to a customer's Google Calendar via a Google OAuth 2.0
 * access token.
 *
 * A governed OUTBOUND connection: OS agents read calendars/events and (approval-gated)
 * create/update events through the SAME capability gate every other connection tool
 * passes. Pure, testable client (`fetch` injected, token injected as an ARG, never
 * logged/returned) + a thin SERVER-SIDE bridge that dereferences the vaulted token HERE.
 *
 * Same discipline as `github.ts`: every call NEVER throws — `{ ok:false, reason }`.
 * A short-lived access token that 401s is surfaced honestly (refresh + re-test);
 * automatic refresh-token rotation is a documented follow-up.
 */

export type GcalFetch = typeof fetch;

export const GCAL_API = 'https://www.googleapis.com/calendar/v3';
export const GCAL_PAGE = 25;

export type GcalConn = {
  baseUrl: string;
  token?: string;
  fetchImpl: GcalFetch;
  timeoutMs?: number;
};

export type GcalResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

export function gcalAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function base(conn: GcalConn): string {
  return (conn.baseUrl || GCAL_API).replace(/\/$/, '');
}

async function withTimeout(conn: GcalConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function cSend(
  conn: GcalConn,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<GcalResult<Record<string, unknown>>> {
  try {
    const init: RequestInit = { method, headers: { ...gcalAuthHeaders(conn.token), ...(body ? { 'content-type': 'application/json' } : {}) } };
    if (body) init.body = JSON.stringify(body);
    const res = await withTimeout(conn, `${base(conn)}${path}`, init);
    if (res.status === 429) return { ok: false, reason: `rate-limited; retry after ${res.headers.get('retry-after') ?? '30'}s` };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (access token expired or invalid — refresh it)' };
    if (res.status === 403) return { ok: false, reason: 'forbidden (missing Calendar scope)' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `Calendar ${res.status}` };
    return { ok: true, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

// --------------------------------------------------------------- liveness -------

/** Liveness: GET /users/me/calendarList. 2xx ⇒ live; 401 ⇒ honest ✗. */
export async function gcalHealth(conn: GcalConn): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const r = await cSend(conn, 'GET', '/users/me/calendarList?maxResults=1');
  if (r.ok) {
    const items = Array.isArray(r.data.items) ? (r.data.items as unknown[]) : [];
    return { connected: true, detail: `${items.length ? 'calendars visible' : 'authenticated'}` };
  }
  return { connected: false, reason: r.reason };
}

// ------------------------------------------------------------- reads (auto) -----

export type GcalCalendar = { id: string; summary: string; primary: boolean };
export type GcalEvent = { id: string; summary: string; start: string; end: string; status: string };

function eventTime(v: unknown): string {
  const t = (v ?? {}) as { dateTime?: string; date?: string };
  return t.dateTime ?? t.date ?? '';
}
function shapeEvent(d: Record<string, unknown>): GcalEvent {
  return { id: String(d.id ?? ''), summary: String(d.summary ?? ''), start: eventTime(d.start), end: eventTime(d.end), status: String(d.status ?? '') };
}

/** GET /users/me/calendarList — list calendars. Read. */
export async function gcalListCalendars(conn: GcalConn): Promise<GcalResult<GcalCalendar[]>> {
  const r = await cSend(conn, 'GET', `/users/me/calendarList?maxResults=${GCAL_PAGE}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.items) ? (r.data.items as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map((d) => ({ id: String(d.id ?? ''), summary: String(d.summary ?? ''), primary: Boolean(d.primary) })), truncated: Boolean(r.data.nextPageToken) };
}

/** GET /calendars/{calendarId}/events — list events. Read. Bounded. */
export async function gcalListEvents(conn: GcalConn, calendarId: string, opts?: { timeMin?: string }): Promise<GcalResult<GcalEvent[]>> {
  const cal = (calendarId || 'primary').trim();
  const qs = new URLSearchParams({ maxResults: String(GCAL_PAGE), singleEvents: 'true', orderBy: 'startTime', ...(opts?.timeMin ? { timeMin: opts.timeMin } : {}) }).toString();
  const r = await cSend(conn, 'GET', `/calendars/${encodeURIComponent(cal)}/events?${qs}`);
  if (!r.ok) return r;
  const rows = Array.isArray(r.data.items) ? (r.data.items as Record<string, unknown>[]) : [];
  return { ok: true, data: rows.map(shapeEvent), truncated: Boolean(r.data.nextPageToken) };
}

/** GET /calendars/{calendarId}/events/{eventId} — read one event. Read. */
export async function gcalGetEvent(conn: GcalConn, calendarId: string, eventId: string): Promise<GcalResult<GcalEvent>> {
  if (!eventId.trim()) return { ok: false, reason: 'get_event needs an event id' };
  const cal = (calendarId || 'primary').trim();
  const r = await cSend(conn, 'GET', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`);
  if (!r.ok) return r;
  return { ok: true, data: shapeEvent(r.data) };
}

// ---------------------------------------------- writes (Write-approval) ---------

/** POST /calendars/{calendarId}/events — create an event. Write — Write-approval upstream. */
export async function gcalCreateEvent(
  conn: GcalConn,
  calendarId: string,
  input: { summary: string; start: string; end: string; description?: string },
): Promise<GcalResult<GcalEvent>> {
  if (!input.summary.trim()) return { ok: false, reason: 'create_event needs a summary' };
  if (!input.start.trim() || !input.end.trim()) return { ok: false, reason: 'create_event needs start and end (RFC3339)' };
  const cal = (calendarId || 'primary').trim();
  const body: Record<string, unknown> = { summary: input.summary, start: { dateTime: input.start }, end: { dateTime: input.end } };
  if (input.description) body.description = input.description;
  const r = await cSend(conn, 'POST', `/calendars/${encodeURIComponent(cal)}/events`, body);
  if (!r.ok) return r;
  return { ok: true, data: shapeEvent(r.data) };
}

/** PATCH /calendars/{calendarId}/events/{eventId} — update an event. Write — Write-approval upstream. */
export async function gcalUpdateEvent(
  conn: GcalConn,
  calendarId: string,
  eventId: string,
  patch: { summary?: string; start?: string; end?: string; description?: string },
): Promise<GcalResult<GcalEvent>> {
  if (!eventId.trim()) return { ok: false, reason: 'update_event needs an event id' };
  const cal = (calendarId || 'primary').trim();
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.start !== undefined) body.start = { dateTime: patch.start };
  if (patch.end !== undefined) body.end = { dateTime: patch.end };
  if (Object.keys(body).length === 0) return { ok: false, reason: 'update_event needs at least one field to change' };
  const r = await cSend(conn, 'PATCH', `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`, body);
  if (!r.ok) return r;
  return { ok: true, data: shapeEvent(r.data) };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure Calendar client config — the OAuth access token is dereferenced
 *  from the vault HERE (server-side) and never leaves this process. */
export function gcalConnFrom(c: Connection): GcalConn {
  return {
    baseUrl: c.endpoint || GCAL_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}
