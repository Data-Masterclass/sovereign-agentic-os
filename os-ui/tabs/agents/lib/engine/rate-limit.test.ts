/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Rate-limit retry tests — wait and retry, give up after N, never retry a budget, cap the wait
 * USER STORY: As the engine engineer I want the 429 rule pinned with a fake caller and a fake clock,
 *             so a regression is caught without a gateway and without waiting a real minute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCall } from '@core/runtime/agentic';
import {
  classifyGatewayLimit,
  describeLimit,
  parseLimitReset,
  planWait,
  withRateLimitRetry,
  RateLimitNotClearedError,
  type RateLimitWait,
} from '@tabs/agents/lib/engine/rate-limit';

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
  assert.deepEqual(plan, { waitMs: 75_000, source: 'limit-reset', capped: true });
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
