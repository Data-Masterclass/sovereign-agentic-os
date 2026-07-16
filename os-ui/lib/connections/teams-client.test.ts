/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type GraphConn } from './outlook.ts';
import {
  teamsHealth,
  teamsListTeams,
  teamsListChannels,
  teamsListChannelMessages,
  teamsPostChannelMessage,
} from './teams.ts';

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

const TOKEN = 'eyJfake-teams-token-xxx';
function conn(fetchImpl: typeof fetch): GraphConn {
  return { baseUrl: 'https://graph.microsoft.com/v1.0', token: TOKEN, fetchImpl };
}

test('listTeams injects the Bearer, shapes rows + truncated flag', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [{ id: 'T1', displayName: 'Sales' }], '@odata.nextLink': 'next' } }));
  const r = await teamsListTeams(conn(f.impl));
  assert.ok(r.ok && r.data[0].id === 'T1' && r.data[0].displayName === 'Sales' && r.truncated === true);
  assert.ok(f.calls[0].url.includes('/me/joinedTeams'));
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('listChannels needs a teamId (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await teamsListChannels(conn(f.impl), '');
  assert.ok(!r.ok && /teamId/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('listChannels shapes rows', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/teams/T1/channels'));
    return { status: 200, body: { value: [{ id: 'C1', displayName: 'General' }] } };
  });
  const r = await teamsListChannels(conn(f.impl), 'T1');
  assert.ok(r.ok && r.data[0].displayName === 'General');
});

test('listChannelMessages shapes from.user.displayName + body.content', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [{ id: 'M1', from: { user: { displayName: 'Ada' } }, body: { content: 'shipping today' }, createdDateTime: 'd' }] } }));
  const r = await teamsListChannelMessages(conn(f.impl), 'T1', 'C1');
  assert.ok(r.ok && r.data[0].from === 'Ada' && r.data[0].text === 'shipping today');
});

test('listChannelMessages needs team + channel', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  assert.ok(!(await teamsListChannelMessages(conn(f.impl), 'T1', '')).ok);
  assert.equal(f.calls.length, 0);
});

test('unseeable id → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await teamsListChannels(conn(f.impl), 'T-missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('post_channel_message: gate-held write path POSTs and shapes the id', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/teams/T1/channels/C1/messages'));
    return { status: 201, body: { id: 'msg1' } };
  });
  const r = await teamsPostChannelMessage(conn(f.impl), 'T1', 'C1', 'hello');
  assert.ok(r.ok && r.data.id === 'msg1');
});

test('post_channel_message validates ids + text before the network (never auto-post empty)', async () => {
  const f = fakeFetch(() => ({ status: 201, body: {} }));
  assert.ok(!(await teamsPostChannelMessage(conn(f.impl), 'T1', 'C1', '')).ok);
  assert.ok(!(await teamsPostChannelMessage(conn(f.impl), '', 'C1', 'hi')).ok);
  assert.equal(f.calls.length, 0);
});

test('health: /me 2xx → connected; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { userPrincipalName: 'me@x.com' } }));
  const h = await teamsHealth(conn(up.impl));
  assert.ok(h.connected && /me@x.com/.test(h.detail ?? ''));
  const bad = fakeFetch(() => ({ status: 401 }));
  const h2 = await teamsHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('rate limit: 429 + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '18' } }));
  const r = await teamsListTeams(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /18/.test(r.reason));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await teamsListTeams({ baseUrl: 'https://graph.microsoft.com/v1.0', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [] } }));
  await teamsListTeams({ baseUrl: 'https://graph.microsoft.com/v1.0', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});
