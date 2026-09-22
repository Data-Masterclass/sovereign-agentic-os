/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type GmailConn,
  gmailAuthHeaders,
  gmailHealth,
  base64UrlEncode,
  buildRawMessage,
  gmailListMessages,
  gmailGetMessage,
  gmailListLabels,
  gmailSendMessage,
  gmailCreateDraft,
  GMAIL_MAX_PAGES,
} from './gmail.ts';

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

const TOKEN = 'ya29.fake-access-token-xxx';
function conn(fetchImpl: typeof fetch): GmailConn {
  return { baseUrl: 'https://gmail.googleapis.com', token: TOKEN, fetchImpl };
}

test('auth: a token yields a Bearer header; no token yields none (honest fail)', () => {
  assert.equal(gmailAuthHeaders(TOKEN).authorization, `Bearer ${TOKEN}`);
  assert.equal(gmailAuthHeaders(undefined).authorization, undefined);
});

test('base64url + buildRawMessage encode a valid RFC822 message (no padding, url-safe)', () => {
  assert.equal(base64UrlEncode('a/b+c'), 'YS9iK2M'); // '/' and '+' remapped, padding stripped
  const raw = buildRawMessage({ to: 'x@y.com', subject: 'Hi', body: 'hello' });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(decoded.includes('To: x@y.com') && decoded.includes('Subject: Hi') && decoded.endsWith('hello'));
});

test('listMessages builds /messages, injects the Bearer, shapes refs + truncated flag', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'p2' } }));
  const r = await gmailListMessages(conn(f.impl), { query: 'from:ada' });
  assert.ok(r.ok && r.data[0].id === 'm1' && r.truncated === true);
  assert.ok(f.calls[0].url.includes('/gmail/v1/users/me/messages') && f.calls[0].url.includes('q=from'));
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('getMessage shapes From/Subject headers + snippet', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { id: 'm1', threadId: 't1', snippet: 'hi there', payload: { headers: [{ name: 'From', value: 'Ada <a@x.com>' }, { name: 'Subject', value: 'Report' }] } } }));
  const r = await gmailGetMessage(conn(f.impl), 'm1');
  assert.ok(r.ok && r.data.from === 'Ada <a@x.com>' && r.data.subject === 'Report' && r.data.snippet === 'hi there');
});

test('getMessage needs an id (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await gmailGetMessage(conn(f.impl), '');
  assert.ok(!r.ok && /message id/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('unseeable id → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await gmailGetMessage(conn(f.impl), 'missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('listLabels shapes rows', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] } }));
  const r = await gmailListLabels(conn(f.impl));
  assert.ok(r.ok && r.data[0].id === 'INBOX');
});

test('send_message: gate-held write path POSTs to /messages/send and shapes the id', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/gmail/v1/users/me/messages/send'));
    return { status: 200, body: { id: 'sent1', threadId: 't9' } };
  });
  const r = await gmailSendMessage(conn(f.impl), { to: 'x@y.com', subject: 'Hi', body: 'yo' });
  assert.ok(r.ok && r.data.id === 'sent1');
});

test('send_message validates to + subject before the network (never auto-send an empty mail)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  assert.ok(!(await gmailSendMessage(conn(f.impl), { to: '', subject: 'x', body: 'b' })).ok);
  assert.ok(!(await gmailSendMessage(conn(f.impl), { to: 'x@y.com', subject: '', body: 'b' })).ok);
  assert.equal(f.calls.length, 0);
});

test('create_draft POSTs to /drafts wrapping the raw message', async () => {
  const f = fakeFetch((url, init) => {
    assert.ok(url.endsWith('/gmail/v1/users/me/drafts'));
    assert.ok(String((init.body as string)).includes('"message"'));
    return { status: 200, body: { id: 'draft1' } };
  });
  const r = await gmailCreateDraft(conn(f.impl), { to: 'x@y.com', subject: 'Hi', body: 'yo' });
  assert.ok(r.ok && r.data.id === 'draft1');
});

test('health: profile 2xx → connected with mailbox; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { emailAddress: 'me@x.com' } }));
  const h = await gmailHealth(conn(up.impl));
  assert.ok(h.connected && /me@x.com/.test(h.detail ?? ''));
  const bad = fakeFetch(() => ({ status: 401 }));
  const h2 = await gmailHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('rate limit: 429 + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '20' } }));
  const r = await gmailListMessages(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /20/.test(r.reason));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }, never throws', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await gmailListMessages({ baseUrl: 'https://gmail.googleapis.com', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { labels: [] } }));
  await gmailListLabels({ baseUrl: 'https://gmail.googleapis.com', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});

// --- bounded pagination ---

test('listMessages follows nextPageToken across two pages and concatenates results', async () => {
  let call = 0;
  const f = fakeFetch(() => {
    call += 1;
    if (call === 1) return { status: 200, body: { messages: [{ id: 'p1m1', threadId: 't1' }], nextPageToken: 'tok2' } };
    return { status: 200, body: { messages: [{ id: 'p2m1', threadId: 't2' }] } }; // no token → done
  });
  const r = await gmailListMessages(conn(f.impl));
  assert.ok(r.ok && r.data.length === 2 && r.data[0].id === 'p1m1' && r.data[1].id === 'p2m1');
  assert.equal(r.truncated, false);
  assert.equal(f.calls.length, 2, 'two pages fetched');
  // second call carries the pageToken
  assert.ok(f.calls[1].url.includes('pageToken=tok2'));
});

test('listMessages caps at GMAIL_MAX_PAGES and sets truncated=true when more pages exist', async () => {
  // always returns a nextPageToken to simulate an unbounded source
  const f = fakeFetch(() => ({ status: 200, body: { messages: [{ id: 'x', threadId: 't' }], nextPageToken: 'keepgoing' } }));
  const r = await gmailListMessages(conn(f.impl));
  assert.ok(r.ok && r.truncated === true);
  assert.equal(f.calls.length, GMAIL_MAX_PAGES, `stops at ${GMAIL_MAX_PAGES} pages`);
});
