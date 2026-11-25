/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    Rate-limit retry tests — wait and retry, give up after N, never retry a budget, cap the wait,
 *             the chat's short total budget, overloaded providers, and Retry-After under fake timers
 * USER STORY: As the engine engineer I want the 429 rule pinned with a fake caller and a fake clock,
 *             so a regression is caught without a gateway and without waiting a real minute.
 * ARCHITECTURE:
 *   - A fake model caller and an injected clock/sleep; the retry rule itself is the unit under test.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCall } from '@core/runtime/agentic';
import {
  classifyGatewayLimit,
  describeLimit,
  parseLimitReset,
  planWait,
  withRateLimitRetry,
  RateLimitNotClearedError,
  CHAT_RATE_LIMIT_RETRY,
  type RateLimitWait,
} from '@core/runtime/rate-limit';

const NOW = Date.parse('2026-11-19T17:19:26Z');
/** The gateway's own wording, as the LiteLLM caller surfaces it. */
const TPM_429 =
  'LiteLLM 429: {"error":{"message":"Rate limit exceeded for api_key: 88dc28d0f030c55ed4ab77ed8faf098196cb1c05df778539800c9f1243fe6b4b. ' +
  'Limit type: tokens. Current limit: 200000, Remaining: 16320. Limit resets at: 2026-11-19 17:20:00 UTC","type":"None","param":"None","code":"429"}}';
const BUDGET_429 = 'LiteLLM 429: {"error":{"message":"Budget has been exceeded! Current cost: 5.01, Max budget: 5.0","type":"budget_exceeded"}}';
const REQ = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

/** A caller that throws the given errors in order, then answers. */
function flaky(errors: unknown[]): { llm: LlmCall; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    llm: async () => {
      const e = errors[n];
      n += 1;
      if (e !== undefined) throw e;
      return { content: 'ok', toolCalls: [] };
    },
  };
}

function harness(errors: unknown[], extra: Parameters<typeof withRateLimitRetry>[1] = {}) {
  const f = flaky(errors);
  const slept: number[] = [];
  const waits: RateLimitWait[] = [];
  let clock = NOW;
  const llm = withRateLimitRetry(f.llm, {
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    jitter: () => 500,
    onWait: (w) => waits.push(w),
    ...extra,
  });
  return { llm, slept, waits, calls: f.calls };
}

test('classify: a tokens-per-minute 429 is a rate limit; a budget 429 is a budget; anything else is neither', () => {
  assert.equal(classifyGatewayLimit(new Error(TPM_429)), 'rate-limit');
  assert.equal(classifyGatewayLimit(new Error(BUDGET_429)), 'budget');
  assert.equal(classifyGatewayLimit(Object.assign(new Error('The LLM budget for this key or team is exhausted.'), { code: 'budget_exceeded' })), 'budget');
  assert.equal(classifyGatewayLimit(Object.assign(new Error('LiteLLM 429: slow down'), { status: 429, retryAfterSeconds: 7 })), 'rate-limit');
  assert.equal(classifyGatewayLimit(new Error('LiteLLM 500: boom')), null);
  assert.equal(classifyGatewayLimit(new Error('gateway down')), null);
});

test('parse: the stated reset time and the limit a person can act on', () => {
  assert.equal(parseLimitReset(TPM_429), Date.parse('2026-11-19T17:20:00Z'));
  assert.equal(parseLimitReset('no reset here'), null);
  assert.equal(describeLimit(TPM_429), 'tokens per minute (limit 200,000)');
});

test('retry then success: waits until the stated reset (plus jitter), says so, and re-sends the SAME request', async () => {
  const h = harness([new Error(TPM_429)]);
  const out = await h.llm(REQ);
  assert.equal(out.content, 'ok');
  assert.equal(h.calls(), 2, 'one failed attempt, one retry');
  assert.deepEqual(h.slept, [34_500], '34 s to the reset + 0.5 s jitter');
  assert.equal(h.waits.length, 1);
  assert.equal(h.waits[0].message, 'Waiting 35 s for the model rate limit to reset — tokens per minute (limit 200,000) (retry 1 of 3)');
});

test('a Retry-After from the caller wins over the message', async () => {
  const h = harness([Object.assign(new Error(TPM_429), { status: 429, retryAfterSeconds: 7 })]);
  await h.llm(REQ);
  assert.deepEqual(h.slept, [7_500]);
});

test('gives up after N: three waits, four calls, then a plain error that names the limit', async () => {
  const e = () => new Error('LiteLLM 429: {"error":{"message":"Rate limit exceeded. Limit type: tokens. Current limit: 200000, Remaining: 0."}}');
  const h = harness([e(), e(), e(), e(), e()]);
  await assert.rejects(h.llm(REQ), (err: Error) => {
    assert.ok(err instanceof RateLimitNotClearedError);
    assert.match(err.message, /did not clear after 3 waits/);
    assert.match(err.message, /tokens per minute \(limit 200,000\)/);
    return true;
  });
  assert.equal(h.calls(), 4, 'the first attempt + exactly 3 retries');
  assert.deepEqual(h.slept, [5_500, 15_500, 30_500], 'no reset stated → the fixed back-off, each with jitter');
});

test('a budget 429 is NOT retried: one call, no wait, a plain message', async () => {
  const h = harness([new Error(BUDGET_429)]);
  await assert.rejects(h.llm(REQ), (err: Error) => {
    assert.match(err.message, /budget .* is used up/);
    assert.match(err.message, /Waiting does not help/);
    return true;
  });
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.slept, []);
  assert.deepEqual(h.waits, []);
});

test('the caller\'s own typed budget error passes through unchanged', async () => {
  const typed = Object.assign(new Error('The LLM budget for this key or team is exhausted. Raise the cap in Admin → LLM Gateway.'), { code: 'budget_exceeded', status: 402 });
  const h = harness([typed]);
  await assert.rejects(h.llm(REQ), (err: Error) => err === typed);
  assert.equal(h.calls(), 1);
});

test('the wait is capped: a reset ten minutes away still waits at most the cap', async () => {
  const far = new Error('LiteLLM 429: Rate limit exceeded. Limit type: requests. Current limit: 120. Limit resets at: 2026-11-19 17:29:26 UTC');
  const h = harness([far], { maxWaitMs: 75_000 });
  await h.llm(REQ);
  assert.deepEqual(h.slept, [75_000]);
  const plan = planWait(far, 1, { now: NOW, maxWaitMs: 75_000, jitterMs: 500 });
  assert.deepEqual(plan, { waitMs: 75_000, source: 'limit-reset', capped: true, wantedMs: 600_500 });
});

test('any other error is thrown straight through, untouched', async () => {
  const boom = new Error('LiteLLM 500: upstream exploded');
  const h = harness([boom]);
  await assert.rejects(h.llm(REQ), (err: Error) => err === boom);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.slept, []);
});

test('an aborted run does not keep waiting', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const first = new Error(TPM_429);
  const h = harness([first, new Error(TPM_429)], { signal: ctrl.signal });
  await assert.rejects(h.llm(REQ), (err: Error) => err === first);
  assert.equal(h.calls(), 1);
});

// ---- overloaded providers and the chat's short budget ---------------------------------------

test('classify: an overloaded provider (503 "overloaded", 529) is waited out like a rate limit; a plain 500/503 is not', () => {
  assert.equal(classifyGatewayLimit(new Error('LiteLLM 503: {"error":{"message":"Overloaded","type":"overloaded_error"}}')), 'rate-limit');
  assert.equal(classifyGatewayLimit(Object.assign(new Error('provider over capacity'), { status: 503 })), 'rate-limit');
  assert.equal(classifyGatewayLimit(new Error('LiteLLM 529: {"type":"error"}')), 'rate-limit');
  assert.equal(classifyGatewayLimit(new Error('LiteLLM 503: upstream connect error')), null);
  assert.equal(classifyGatewayLimit(new Error('LiteLLM 500: {"error":"boom"}')), null);
});

test('chat budget: two busy answers, then the answer — two short waits, three calls', async () => {
  const busy = () => new Error('LiteLLM 429: {"error":{"message":"RateLimitError: model group failed. No fallback was attempted."}}');
  const h = harness([busy(), busy()], { ...CHAT_RATE_LIMIT_RETRY });
  const out = await h.llm(REQ);
  assert.equal(out.content, 'ok');
  assert.equal(h.calls(), 3);
  assert.deepEqual(h.slept, [2_500, 6_500], 'the chat back-off (2 s, 6 s) plus jitter');
  assert.deepEqual(h.waits.map((w) => w.maxAttempts), [2, 2]);
});

test('chat budget: still busy after two retries → RateLimitNotClearedError, total wait ≤ 20 s', async () => {
  const busy = () => new Error('LiteLLM 429: rate limit');
  const h = harness([busy(), busy(), busy(), busy()], { ...CHAT_RATE_LIMIT_RETRY });
  await assert.rejects(h.llm(REQ), (err: Error) => err instanceof RateLimitNotClearedError);
  assert.equal(h.calls(), 3);
  assert.ok(h.slept.reduce((a, b) => a + b, 0) <= 20_000);
});

test('chat budget: a Retry-After longer than the budget is NOT undercut — it gives up at once, no early re-send', async () => {
  const h = harness([Object.assign(new Error('LiteLLM 429: slow down'), { status: 429, retryAfterSeconds: 30 })], { ...CHAT_RATE_LIMIT_RETRY });
  await assert.rejects(h.llm(REQ), (err: Error) => err instanceof RateLimitNotClearedError);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.slept, []);
});

test('a call whose answer had begun to stream is never re-sent', async () => {
  let n = 0;
  const seen: string[] = [];
  const llm = withRateLimitRetry(async (req) => {
    n += 1;
    req.onToken?.('Hel');
    throw new Error('LiteLLM 429: rate limit');
  }, { sleep: async () => {}, jitter: () => 0 });
  await assert.rejects(llm({ ...REQ, onToken: (t) => seen.push(t) }), /LiteLLM 429/);
  assert.equal(n, 1);
  assert.deepEqual(seen, ['Hel'], 'the caller still saw what streamed');
});

test('Retry-After is honoured with the REAL sleep (fake timers): no re-send before it has passed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let n = 0;
    const llm = withRateLimitRetry(async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('LiteLLM 429: slow down'), { status: 429, retryAfterSeconds: 3 });
      return { content: 'ok', toolCalls: [] };
    }, { ...CHAT_RATE_LIMIT_RETRY, jitter: () => 0 });
    const out = llm(REQ);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.equal(n, 1);
    mock.timers.tick(2_999);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.equal(n, 1, 'not re-sent before the 3 s Retry-After');
    mock.timers.tick(1);
    assert.equal((await out).content, 'ok');
    assert.equal(n, 2);
  } finally {
    mock.timers.reset();
  }
});
