/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type GcalConn,
  gcalAuthHeaders,
  gcalHealth,
  gcalListCalendars,
  gcalListEvents,
  gcalGetEvent,
  gcalCreateEvent,
  gcalUpdateEvent,
} from './gcal.ts';

function fakeFetch(
  script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    const headers = new Headers(r.headers ?? {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'ya29.fake-cal-token-xxx';
function conn(fetchImpl: typeof fetch): GcalConn {
  return { baseUrl: 'https://www.googleapis.com/calendar/v3', token: TOKEN, fetchImpl };
}

test('auth: a token yields a Bearer header; no token yields none (honest fail)', () => {
  assert.equal(gcalAuthHeaders(TOKEN).authorization, `Bearer ${TOKEN}`);
  assert.equal(gcalAuthHeaders(undefined).authorization, undefined);
});

test('listCalendars injects the Bearer, shapes rows + truncated flag', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { items: [{ id: 'c1', summary: 'Work', primary: true }], nextPageToken: 'p2' } }));
  const r = await gcalListCalendars(conn(f.impl));
  assert.ok(r.ok && r.data[0].id === 'c1' && r.data[0].primary === true && r.truncated === true);
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('listEvents defaults to primary and shapes start/end from dateTime|date', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/calendars/primary/events'));
    return { status: 200, body: { items: [{ id: 'e1', summary: 'Standup', start: { dateTime: '2026-07-16T09:00:00Z' }, end: { date: '2026-07-16' }, status: 'confirmed' }] } };
  });
  const r = await gcalListEvents(conn(f.impl), '');
  assert.ok(r.ok && r.data[0].start === '2026-07-16T09:00:00Z' && r.data[0].end === '2026-07-16');
});

test('getEvent needs an id (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await gcalGetEvent(conn(f.impl), 'primary', '');
  assert.ok(!r.ok && /event id/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('unseeable id → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await gcalGetEvent(conn(f.impl), 'primary', 'missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('create_event: gate-held write path POSTs and shapes the event', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/calendars/primary/events'));
    return { status: 200, body: { id: 'e9', summary: 'Sync', start: { dateTime: 's' }, end: { dateTime: 'e' }, status: 'confirmed' } };
  });
  const r = await gcalCreateEvent(conn(f.impl), 'primary', { summary: 'Sync', start: '2026-07-16T09:00:00Z', end: '2026-07-16T09:30:00Z' });
  assert.ok(r.ok && r.data.id === 'e9');
});

test('create_event validates summary + start/end before the network', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  assert.ok(!(await gcalCreateEvent(conn(f.impl), 'primary', { summary: '', start: 's', end: 'e' })).ok);
  assert.ok(!(await gcalCreateEvent(conn(f.impl), 'primary', { summary: 'x', start: '', end: 'e' })).ok);
  assert.equal(f.calls.length, 0);
});

test('update_event PATCHes changed fields and needs at least one field', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'PATCH');
    return { status: 200, body: { id: 'e1', summary: 'New', start: { dateTime: 's' }, end: { dateTime: 'e' } } };
  });
  const r = await gcalUpdateEvent(conn(f.impl), 'primary', 'e1', { summary: 'New' });
  assert.ok(r.ok && r.data.summary === 'New');
  const empty = await gcalUpdateEvent(conn(f.impl), 'primary', 'e1', {});
  assert.ok(!empty.ok && /at least one field/.test(empty.reason));
});

test('health: calendarList 2xx → connected; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { items: [{ id: 'c1' }] } }));
  assert.ok((await gcalHealth(conn(up.impl))).connected);
  const bad = fakeFetch(() => ({ status: 401 }));
  const h = await gcalHealth(conn(bad.impl));
  assert.ok(!h.connected && /unauthorized/.test(h.reason ?? ''));
});

test('rate limit: 429 + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '15' } }));
  const r = await gcalListCalendars(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /15/.test(r.reason));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await gcalListCalendars({ baseUrl: 'https://www.googleapis.com/calendar/v3', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { items: [] } }));
  await gcalListCalendars({ baseUrl: 'https://www.googleapis.com/calendar/v3', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});
