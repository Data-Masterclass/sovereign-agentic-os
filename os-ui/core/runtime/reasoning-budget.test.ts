/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A reply whose whole output budget went on reasoning is not an "empty reply".
 * USER STORY: As a user of a reasoning model (always-on thinking) I get my answer, or an exact
 *             reason why not, instead of "the model returned nothing".
 * ARCHITECTURE: the ONE model caller (`liteLlmCaller`) retries once with a larger `max_tokens` (up to
 *             the model's max output) when `finish_reason=length`, `content` is empty and reasoning
 *             is present; if that is exhausted too it throws a precise typed error.
 * NEGATIVE TWINS: a length stop WITH content is kept (not retried); an empty reply WITHOUT reasoning
 *             is not reclassified; the ceiling is never exceeded.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseLlmMessage, parseLlmUsage, liteLlmCaller } from '@core/runtime/runtime';
import { isReasoningExhausted, ReasoningBudgetExhaustedError } from '@core/runtime/reasoning-budget';
import { setCatalogLimits, resetCatalogLimits } from '@core/models/model-limits';

const reasoningOnly = (tokens = 300) => ({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'let me think about the report '.repeat(20) } }], usage: { prompt_tokens: 50, completion_tokens: tokens, total_tokens: 50 + tokens, completion_tokens_details: { reasoning_tokens: tokens } } });
const answer = (content = 'the report') => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: 'thought' } }], usage: { prompt_tokens: 50, completion_tokens: 900, total_tokens: 950, completion_tokens_details: { reasoning_tokens: 400 } } });

let sent: Array<Record<string, unknown>> = [];
const origFetch = globalThis.fetch;
function gateway(replies: unknown[]) {
  sent = [];
  let i = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
beforeEach(() => { resetCatalogLimits(); globalThis.fetch = origFetch; });
process.on('exit', () => { globalThis.fetch = origFetch; });
const ask = (maxTokens?: number, model = 'sovereign-strong') => liteLlmCaller()({ model, messages: [{ role: 'user', content: 'write the long report' }], ...(maxTokens ? { maxTokens } : {}) });
const limits = (maxOutput: number, target = 'kimi-k3.1-pro') => setCatalogLimits({ 'sovereign-strong': { contextWindow: 256000, maxOutput, target } });

test('parseLlmMessage records reasoning (text and the usage-reported tokens) without putting it in content', () => {
  const c = parseLlmMessage({ content: '', reasoning_content: 'thinking hard' }, 'length');
  assert.equal(c.content, '');
  assert.equal(c.reasoning?.chars, 'thinking hard'.length);
  assert.equal(parseLlmUsage({ prompt_tokens: 1, completion_tokens: 300, total_tokens: 301, completion_tokens_details: { reasoning_tokens: 290 } })?.reasoning, 290);
  assert.equal(parseLlmMessage({ content: 'x' }).reasoning, undefined);
});

test('isReasoningExhausted: only a length stop with no content, no tool call and reasoning present', () => {
  const base = { content: '', toolCalls: [], finishReason: 'length', reasoning: { chars: 10 } };
  assert.equal(isReasoningExhausted(base), true);
  assert.equal(isReasoningExhausted({ ...base, content: 'partial answer' }), false);
  assert.equal(isReasoningExhausted({ ...base, reasoning: undefined }), false);
  assert.equal(isReasoningExhausted({ ...base, finishReason: 'stop' }), false);
  assert.equal(isReasoningExhausted({ ...base, toolCalls: [{ id: 'c', name: 't', args: {} }] }), false);
});

test('a reasoning-exhausted reply is retried ONCE with a larger max_tokens and the answer is returned', async () => {
  limits(262144);
  gateway([reasoningOnly(300), answer('the full report')]);
  const out = await ask(300);
  assert.equal(out.content, 'the full report');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].max_tokens, 300);
  assert.equal(sent[1].max_tokens, 1200, 'retried at four times the budget');
});

test('the retry never exceeds the model\'s max output', async () => {
  limits(1000);
  gateway([reasoningOnly(300), answer()]);
  await ask(300);
  assert.equal(sent[1].max_tokens, 1000);
});

test('still exhausted after the retry: the failure names the reasoning tokens, the role and the model', async () => {
  limits(262144);
  gateway([reasoningOnly(300), reasoningOnly(1200)]);
  await assert.rejects(ask(300), (e: unknown) => {
    assert.ok(e instanceof ReasoningBudgetExhaustedError);
    assert.match((e as Error).message, /the model spent its whole output budget on reasoning \(1200 tokens\); raise the output limit for sovereign-strong\/kimi-k3\.1-pro/);
    return true;
  });
  assert.equal(sent.length, 2, 'exactly one retry');
});

test('already at the model\'s max output: no pointless retry, the precise failure at once', async () => {
  limits(300);
  gateway([reasoningOnly(300), answer()]);
  await assert.rejects(ask(300), ReasoningBudgetExhaustedError);
  assert.equal(sent.length, 1);
});

test('NEGATIVE TWIN: a length stop WITH content is kept as the (cut-off) answer, not retried', async () => {
  limits(262144);
  gateway([{ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'half a report', reasoning_content: 'x' } }] }]);
  const out = await ask(300);
  assert.equal(out.content, 'half a report');
  assert.equal(out.finishReason, 'length');
  assert.equal(sent.length, 1);
});

test('NEGATIVE TWIN: an empty reply from a model that did not reason stays an empty reply (the engine\'s own nudge handles it)', async () => {
  limits(262144);
  gateway([{ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] }]);
  const out = await ask(300);
  assert.equal(out.content, '');
  assert.equal(sent.length, 1);
});

test('NEGATIVE TWIN: a normal answer is passed through untouched and no extra call is made', async () => {
  gateway([answer('hello')]);
  assert.equal((await ask(300)).content, 'hello');
  assert.equal(sent.length, 1);
});
