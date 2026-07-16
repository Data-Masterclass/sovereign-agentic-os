/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type GraphConn,
  graphAuthHeaders,
  graphMessageBody,
  outlookHealth,
  outlookListMessages,
  outlookGetMessage,
  outlookSendMail,
  outlookCreateDraft,
} from './outlook.ts';

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

const TOKEN = 'eyJfake-graph-token-xxx';
function conn(fetchImpl: typeof fetch): GraphConn {
  return { baseUrl: 'https://graph.microsoft.com/v1.0', token: TOKEN, fetchImpl };
}

test('auth: a token yields a Bearer header; no token yields none (honest fail)', () => {
  assert.equal(graphAuthHeaders(TOKEN).authorization, `Bearer ${TOKEN}`);
  assert.equal(graphAuthHeaders(undefined).authorization, undefined);
});

test('graphMessageBody builds a Text message with a recipient', () => {
  const b = graphMessageBody({ to: 'x@y.com', subject: 'Hi', body: 'yo' }) as any;
  assert.equal(b.body.contentType, 'Text');
  assert.equal(b.toRecipients[0].emailAddress.address, 'x@y.com');
});

test('listMessages injects the Bearer, shapes rows + truncated on @odata.nextLink', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [{ id: 'm1', subject: 'Report', from: { emailAddress: { address: 'a@x.com' } }, receivedDateTime: 'd', bodyPreview: 'hi' }], '@odata.nextLink': 'next' } }));
  const r = await outlookListMessages(conn(f.impl), { search: 'report' });
  assert.ok(r.ok && r.data[0].from === 'a@x.com' && r.data[0].subject === 'Report' && r.truncated === true);
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test('getMessage needs an id (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await outlookGetMessage(conn(f.impl), '');
  assert.ok(!r.ok && /message id/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('unseeable id → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await outlookGetMessage(conn(f.impl), 'missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('send_mail: gate-held write path POSTs to /me/sendMail; 202 has no body but ok', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/me/sendMail'));
    return { status: 202 };
  });
  const r = await outlookSendMail(conn(f.impl), { to: 'x@y.com', subject: 'Hi', body: 'yo' });
  assert.ok(r.ok && r.data.sent === true);
});

test('send_mail validates to + subject before the network (never auto-send an empty mail)', async () => {
  const f = fakeFetch(() => ({ status: 202 }));
  assert.ok(!(await outlookSendMail(conn(f.impl), { to: '', subject: 'x', body: 'b' })).ok);
  assert.ok(!(await outlookSendMail(conn(f.impl), { to: 'x@y.com', subject: '', body: 'b' })).ok);
  assert.equal(f.calls.length, 0);
});

test('create_draft POSTs to /me/messages and shapes the id', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.endsWith('/me/messages'));
    return { status: 201, body: { id: 'draft1' } };
  });
  const r = await outlookCreateDraft(conn(f.impl), { to: 'x@y.com', subject: 'Hi', body: 'yo' });
  assert.ok(r.ok && r.data.id === 'draft1');
});

test('health: /me 2xx → connected with mailbox; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { mail: 'me@x.com' } }));
  const h = await outlookHealth(conn(up.impl));
  assert.ok(h.connected && /me@x.com/.test(h.detail ?? ''));
  const bad = fakeFetch(() => ({ status: 401 }));
  const h2 = await outlookHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('rate limit: 429 + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '25' } }));
  const r = await outlookListMessages(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /25/.test(r.reason));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await outlookListMessages({ baseUrl: 'https://graph.microsoft.com/v1.0', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [] } }));
  await outlookListMessages({ baseUrl: 'https://graph.microsoft.com/v1.0', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});
