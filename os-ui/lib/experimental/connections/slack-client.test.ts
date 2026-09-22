/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type SlackConn,
  slackAuthHeaders,
  slackHealth,
  listChannels,
  listUsers,
  conversationsHistory,
  postMessage,
  SLACK_MAX_PAGES,
} from './slack.ts';

/** A recording fake fetch: captures every request and returns a scripted response. */
function fakeFetch(
  script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    const headers = new Headers(r.headers ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers,
      json: async () => r.body ?? {},
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'xoxb-fake-bot-token-xxx';
function conn(fetchImpl: typeof fetch): SlackConn {
  return { baseUrl: 'https://slack.com/api', token: TOKEN, fetchImpl };
}

test('auth: a token yields a Bearer header; no token yields none (honest fail)', () => {
  assert.equal(slackAuthHeaders(TOKEN).authorization, `Bearer ${TOKEN}`);
  assert.equal(slackAuthHeaders(undefined).authorization, undefined);
});

test('listChannels calls conversations.list, injects the Bearer, and shapes rows', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false, num_members: 5 }] } }));
  const r = await listChannels(conn(f.impl));
  assert.ok(r.ok && r.data[0].id === 'C1' && r.data[0].name === 'general' && r.data[0].members === 5);
  assert.ok(f.calls[0].url.startsWith('https://slack.com/api/conversations.list'));
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('listUsers shapes real_name from the profile object', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, members: [{ id: 'U1', name: 'ada', is_bot: false, profile: { real_name: 'Ada Lovelace' } }] } }));
  const r = await listUsers(conn(f.impl));
  assert.ok(r.ok && r.data[0].realName === 'Ada Lovelace' && r.data[0].isBot === false);
});

test('conversationsHistory reads messages for a channel', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, messages: [{ user: 'U1', text: 'shipping today', ts: '111.222' }] } }));
  const r = await conversationsHistory(conn(f.impl), 'C1');
  assert.ok(r.ok && r.data[0].text === 'shipping today' && r.data[0].ts === '111.222');
});

test('conversationsHistory needs a channel (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  const r = await conversationsHistory(conn(f.impl), '');
  assert.ok(!r.ok && /channel/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('unseeable id → not_found (Slack channel_not_found body mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: false, error: 'channel_not_found' } }));
  const r = await conversationsHistory(conn(f.impl), 'C-missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('Slack signals errors in the JSON body (HTTP 200 + ok:false), not the status', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: false, error: 'missing_scope' } }));
  const r = await listChannels(conn(f.impl));
  assert.ok(!r.ok && /missing scope/.test(r.reason));
});

test('rate limit: ratelimited body + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': '42' } }));
  const r = await listUsers(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /42/.test(r.reason));
});

test('rate limit: HTTP 429 also surfaces retry-after honestly', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '30' } }));
  const r = await listChannels(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /30/.test(r.reason));
});

test('pagination: follows next_cursor and flags truncated past the page bound', async () => {
  let page = 0;
  const f = fakeFetch(() => {
    page += 1;
    return { status: 200, body: { ok: true, channels: [{ id: `C${page}`, name: `c${page}` }], response_metadata: { next_cursor: `cur${page}` } } };
  });
  const r = await listChannels(conn(f.impl));
  assert.ok(r.ok && r.truncated === true);
  assert.equal(f.calls.length, SLACK_MAX_PAGES);
});

test('post_message: gate-held write path executes and shapes the posted ts', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/chat.postMessage'));
    return { status: 200, body: { ok: true, channel: 'C1', ts: '999.000' } };
  });
  const r = await postMessage(conn(f.impl), { channel: 'C1', text: 'hello' });
  assert.ok(r.ok && r.data.ts === '999.000' && r.data.channel === 'C1');
});

test('post_message validates channel + text before the network', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  assert.ok(!(await postMessage(conn(f.impl), { channel: '', text: 'x' })).ok);
  assert.ok(!(await postMessage(conn(f.impl), { channel: 'C1', text: '' })).ok);
  assert.equal(f.calls.length, 0);
});

test('health: auth.test ok → connected with detail; invalid_auth → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { ok: true, team: 'Acme', user: 'os-bot' } }));
  const h = await slackHealth(conn(up.impl));
  assert.ok(h.connected && /os-bot/.test(h.detail ?? '') && /Acme/.test(h.detail ?? ''));
  const bad = fakeFetch(() => ({ status: 200, body: { ok: false, error: 'invalid_auth' } }));
  const h2 = await slackHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }, never throws', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await listChannels({ baseUrl: 'https://slack.com/api', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure, not a broken header)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, channels: [] } }));
  await listChannels({ baseUrl: 'https://slack.com/api', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});
