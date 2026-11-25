/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS chat waits out a busy model instead of showing the gateway's raw error
 * USER STORY: As a chat user I want a rate-limited or overloaded model to be retried briefly with a
 *             quiet "the model is busy — retrying…" line, and — when it stays busy — one plain
 *             sentence, never the provider's JSON, a key or an internal model name.
 * ARCHITECTURE: the REAL route (`app/api/assistant/chat/route.ts`) and the REAL `runOsAssistant`
 *             with its rate-limit retry (`rate-limit.ts`). Only auth, the model (scripted), the
 *             governed dispatch (a spy) and the retry's sleep (instant) are stand-ins.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import type { RpcDispatch } from '@core/runtime/agent-loop';
import { GatewayRateLimitedError } from '@core/infra/litellm-credential';
import { __resetConfirmations } from '@core/policy/confirmations';
import { askFailure, askRetryStatusEvent, MODEL_BUSY_GIVE_UP, MODEL_BUSY_RETRYING, MODEL_UNREACHABLE } from '@core/runtime/ask-response';
import { RateLimitNotClearedError } from '@core/runtime/rate-limit';

const creator: CurrentUser = { id: 'u-creator', name: 'Robin', domains: ['sales'], role: 'creator' };

/** The gateway's answer as users saw it in the chat before this fix. */
const RAW_429_BODY =
  '{"error":{"message":"litellm.RateLimitError: RateLimitError: model group \'sovereign-strong\' failed after retries. ' +
  'Received Model Group=sovereign-strong. Available Model Group Fallbacks=None. No fallback was attempted.","type":"None","param":"None","code":"429"}}';
const busy = () => new GatewayRateLimitedError(RAW_429_BODY, null);

let LLM: LlmCall = async () => ({ content: '', toolCalls: [] });
const reached: string[] = [];
const dispatch: RpcDispatch = async (_user, req) => {
  reached.push(String((req.params as { name?: string }).name));
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } };
};
const instant = { sleep: async () => {}, jitter: () => 0 };

const real = await import('@core/runtime/agent-loop');
mock.module('@core/kernel/auth', { namedExports: { requireUser: async () => creator } });
mock.module('@core/runtime/agent-loop', {
  namedExports: {
    ...real,
    runOsAssistant: (input: Parameters<typeof real.runOsAssistant>[0]) =>
      real.runOsAssistant({ ...input, llm: LLM, dispatch, rateLimitRetry: instant }),
  },
});
const { POST } = await import('../../app/api/assistant/chat/route.ts');

beforeEach(() => { __resetConfirmations(); reached.length = 0; });

/** A model that throws the given errors in order, then answers; counts its calls. */
function scripted(errors: unknown[], answer = 'All good.'): { llm: LlmCall; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    llm: async () => {
      const e = errors[n];
      n += 1;
      if (e !== undefined) throw e;
      return { content: answer, toolCalls: [] };
    },
  };
}

const call = (body: Record<string, unknown>) =>
  POST(new Request('http://os.test/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const turn = { path: '/', messages: [{ role: 'user', content: 'what data do I have?' }] };
const streamEvents = async (res: Response) =>
  (await res.text()).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

/** Nothing the provider said, and no internal model name, may reach the browser. */
function assertNoLeak(text: string) {
  for (const bad of ['{', 'LiteLLM', 'RateLimitError', 'sovereign-strong', 'fallback', '429']) {
    assert.ok(!text.includes(bad), `"${bad}" leaked to the user: ${text}`);
  }
}

test('retry then success: a busy model is retried, the turn answers, and the wait is reported', async () => {
  const m = scripted([busy()]);
  const waits: number[] = [];
  const res = await real.runOsAssistant({
    user: creator, tab: null, messages: [{ role: 'user', content: 'hi' }], llm: m.llm, dispatch,
    rateLimitRetry: instant, onRetryWait: (w) => waits.push(w.attempt),
  });
  assert.equal(res.finalText, 'All good.');
  assert.ok(m.calls() >= 2, 'the busy call was sent again');
  assert.deepEqual(waits, [1]);
});

test('a non-rate-limit error is NOT retried', async () => {
  const boom = new Error('LiteLLM 500: {"error":"internal"}');
  const m = scripted([boom]);
  const waits: number[] = [];
  await assert.rejects(
    real.runOsAssistant({ user: creator, tab: null, messages: [{ role: 'user', content: 'hi' }], llm: m.llm, dispatch, rateLimitRetry: instant, onRetryWait: (w) => waits.push(w.attempt) }),
    (e: Error) => e === boom,
  );
  assert.equal(m.calls(), 1);
  assert.deepEqual(waits, []);
});

test('only the model call is retried: a tool that already ran is not run again', async () => {
  let n = 0;
  LLM = async (req) => {
    n += 1;
    if (!req.tools) return { content: '1. look', toolCalls: [] };
    if (n === 2) return { content: '', toolCalls: [{ id: 'c1', name: 'whoami', args: {} }] };
    if (n === 3) throw busy();
    return { content: 'You are Robin.', toolCalls: [] };
  };
  const res = await real.runOsAssistant({ user: creator, tab: null, messages: [{ role: 'user', content: 'who am I' }], llm: LLM, dispatch, rateLimitRetry: instant });
  assert.equal(res.finalText, 'You are Robin.');
  assert.deepEqual(reached, ['whoami'], 'the governed tool ran exactly once');
});

test('STREAM: the wait is a status event; the answer still arrives', async () => {
  LLM = scripted([busy()]).llm;
  const events = await streamEvents(await call({ ...turn, stream: true }));
  const status = events.filter((e) => e.type === 'status');
  assert.equal(status.length, 1);
  assert.equal(status[0].message, MODEL_BUSY_RETRYING);
  assertNoLeak(String(status[0].message));
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(events.find((e) => e.type === 'error'), undefined);
});

test('STREAM exhausted: status events, then ONE friendly error — no raw JSON', async () => {
  LLM = scripted([busy(), busy(), busy(), busy(), busy(), busy()]).llm;
  const errors: unknown[] = [];
  const log = mock.method(console, 'error', (...a: unknown[]) => { errors.push(a.join(' ')); });
  try {
    const events = await streamEvents(await call({ ...turn, stream: true }));
    assert.equal(events.filter((e) => e.type === 'status').length, 2, 'two retries, each announced');
    const err = events.find((e) => e.type === 'error');
    assert.equal(err?.error, MODEL_BUSY_GIVE_UP);
    for (const e of events) assertNoLeak(String(e.message ?? e.error ?? ''));
    assert.ok(!JSON.stringify(events).includes('sovereign-strong'), 'no internal model name anywhere on the wire');
    assert.ok(!JSON.stringify(events).includes('RateLimitError'), 'no provider error anywhere on the wire');
  } finally {
    log.mock.restore();
  }
  assert.ok(errors.some((l) => String(l).includes('sovereign-strong')), 'the technical detail is kept in the server log');
});

test('JSON exhausted: a 503 with the friendly sentence — no raw JSON', async () => {
  LLM = scripted([busy(), busy(), busy(), busy(), busy(), busy()]).llm;
  const log = mock.method(console, 'error', () => {});
  try {
    const res = await call(turn);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, MODEL_BUSY_GIVE_UP);
    assertNoLeak(body.error);
    assert.ok(!JSON.stringify(body).includes('sovereign-strong'));
  } finally {
    log.mock.restore();
  }
});

test('askFailure: busy → friendly; other raw gateway errors → generic; OS sentences kept', () => {
  assert.deepEqual(askFailure(new RateLimitNotClearedError(2, 8_000, '', busy())), { error: MODEL_BUSY_GIVE_UP, status: 503 });
  assert.deepEqual(askFailure(busy()), { error: MODEL_BUSY_GIVE_UP, status: 503 });
  assert.deepEqual(askFailure(new Error('LiteLLM 503: {"error":{"message":"overloaded"}}')), { error: MODEL_BUSY_GIVE_UP, status: 503 });
  assert.deepEqual(askFailure(new Error('LiteLLM 500: {"error":"x","model":"sovereign-strong"}')), { error: MODEL_UNREACHABLE, status: 502 });
  assert.equal(askFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })).status, 504);
  assert.match(askFailure(new Error('Something plain')).error, /Something plain/);
});

test('askRetryStatusEvent carries no limit, key or model name', () => {
  const ev = askRetryStatusEvent({ attempt: 1, maxAttempts: 2, waitMs: 2_000 });
  assert.deepEqual(ev, { type: 'status', status: 'retrying', message: MODEL_BUSY_RETRYING, attempt: 1, maxAttempts: 2, waitMs: 2_000 });
});
