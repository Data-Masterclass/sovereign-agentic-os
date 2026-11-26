/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The saas-http door keeps only a 403's vendor code and permission flag, read bounded
 * USER STORY: As a user I want "your sign-in lacks a permission" told apart from "a mailbox rule refused
 *             it", without the vendor's text echoed, and a slow or endless error body never holding my turn.
 * ARCHITECTURE: `saasRequest` against hand-built `Response`s whose bodies are ReadableStreams (endless,
 *   stalled, huge) — the fake fetch ignores the abort signal on purpose, so only the door's own bound and
 *   timeout can stop the read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saasRequest, readBounded, failureErrorCode, failureMentionsPermission, FORBIDDEN_BODY_MAX } from '@core/adapters/saas-http/client';

const forbidden = (body: BodyInit | null) => (async () => new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const fail = async (f: typeof fetch, timeoutMs = 2000) => {
  const r = await saasRequest('https://graph.example/v1.0/me/sendMail', { method: 'POST', bearer: 'TOKEN', timeoutMs }, f);
  assert.equal(r.ok, false);
  return r as { ok: false; detail: string };
};

test('a 403 keeps the vendor code and whether its message names a permission — never the text', async () => {
  const r = await fail(forbidden(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'Access is denied. The token lacks the required permissions. secret-ish detail' } })));
  assert.equal(failureErrorCode(r), 'ErrorAccessDenied');
  assert.equal(failureMentionsPermission(r), true);
  assert.equal(r.detail.includes('secret-ish'), false);
  // TWIN: a policy refusal has its code and no permission flag.
  const p = await fail(forbidden(JSON.stringify({ error: { code: 'ErrorSendAsDenied', message: 'The user may not send on behalf of that account.' } })));
  assert.equal(failureErrorCode(p), 'ErrorSendAsDenied');
  assert.equal(failureMentionsPermission(p), false);
});

test('the code must match a strict identifier pattern; anything else is code-unknown', async () => {
  for (const code of ['Error<script>', 'Error Access', 'x'.repeat(65), 'Ärger', '', 42]) {
    const r = await fail(forbidden(JSON.stringify({ error: { code, message: 'permission' } })));
    assert.equal(failureErrorCode(r), null, String(code));
    assert.match(r.detail, /code-unknown/);
  }
  const notJson = await fail(forbidden('<html>Forbidden</html>'));
  assert.equal(failureErrorCode(notJson), null);
  assert.match(notJson.detail, /code-unknown/);
});

test('a huge 403 body is read only up to the bound: the code is still found, the rest is never pulled', async () => {
  let pulled = 0;
  const head = new TextEncoder().encode(JSON.stringify({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } }));
  let first = true;
  const endless = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const chunk = first ? head : new TextEncoder().encode(' '.repeat(1024));
      first = false;
      pulled += chunk.length;
      ctrl.enqueue(chunk);
    },
  });
  const started = Date.now();
  const r = await fail(forbidden(endless));
  assert.equal(failureErrorCode(r), 'Authorization_RequestDenied');
  assert.ok(pulled < FORBIDDEN_BODY_MAX + 64 * 1024, `pulled ${pulled} bytes of an endless body`);
  assert.ok(Date.now() - started < 1000);
});

test('a 403 body that never ends (stalls) is abandoned at the request timeout — the turn is not held', async () => {
  const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
  const started = Date.now();
  const r = await fail(forbidden(stalled), 150);
  const took = Date.now() - started;
  assert.match(r.detail, /^HTTP 403 code-unreadable/);
  assert.ok(took >= 140 && took < 1500, `took ${took} ms`);
});

test('readBounded cancels the rest of the body and removes its abort listener when it is done', async () => {
  let cancelled = 0;
  let reads = 0;
  const chunk = new TextEncoder().encode('x'.repeat(4096));
  const reader = {
    read: async () => { reads += 1; return { done: false, value: chunk }; },
    cancel: async () => { cancelled += 1; },
  };
  const res = { body: { getReader: () => reader } } as unknown as Pick<Response, 'body'>;
  const listeners = new Set<unknown>();
  const signal = {
    aborted: false,
    addEventListener: (_t: string, fn: unknown) => { listeners.add(fn); },
    removeEventListener: (_t: string, fn: unknown) => { listeners.delete(fn); },
  } as unknown as AbortSignal;
  const r = await readBounded(res, signal, FORBIDDEN_BODY_MAX);
  assert.equal(r.ok, true);
  assert.equal(reads, Math.ceil(FORBIDDEN_BODY_MAX / chunk.length), 'stops at the bound');
  assert.equal(cancelled, 1, 'the rest of the body is cancelled');
  assert.equal(listeners.size, 0, 'no abort listener is left on the request signal');
  // TWIN: a body that ends by itself reads in full and also leaves no listener.
  let done = false;
  const short = {
    read: async () => {
      if (done) return { done: true, value: undefined };
      done = true;
      return { done: false, value: new TextEncoder().encode('{}') };
    },
    cancel: async () => { cancelled += 1; },
  };
  const r2 = await readBounded({ body: { getReader: () => short } } as unknown as Pick<Response, 'body'>, signal, FORBIDDEN_BODY_MAX);
  assert.deepEqual(r2, { ok: true, text: '{}' });
  assert.equal(listeners.size, 0);
});
