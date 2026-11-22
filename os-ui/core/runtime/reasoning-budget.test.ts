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
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    // Only the model call is the gateway's; anything else (the settings store's first read) is not part of this test.
    if (!String(url).endsWith('/v1/chat/completions')) return new Response('{}', { status: 404 });
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
beforeEach(() => { resetCatalogLimits(); globalThis.fetch = origFetch; });
process.on('exit', () => { globalThis.fetch = origFetch; });
const ask = (maxTokens?: number, model = 'sovereign-strong', reasoningEffort?: 'low' | 'medium' | 'high') => liteLlmCaller()({ model, messages: [{ role: 'user', content: 'write the long report' }], ...(maxTokens ? { maxTokens } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
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
  assert.equal(sent[1].max_tokens, 1200, 'a tight cap is raised four times (never past the normal reserve)');
  assert.equal(sent[1].reasoning_effort, 'low', 'and the model is told to think less');
});

test('a RUNAWAY (the normal budget was used up thinking) is retried at the SAME cap with lower effort, not a bigger cap', async () => {
  setCatalogLimits({ 'sovereign-strong': { contextWindow: 128000, maxOutput: 32768, target: 'kimi-k3.1-pro' } }); // normal reserve = 128000/8 = 16000: the call used exactly it
  gateway([reasoningOnly(16000), answer('the report')]);
  const out = await ask(16000, 'sovereign-strong', 'medium');
  assert.equal(out.content, 'the report');
  assert.equal(sent[0].reasoning_effort, 'medium');
  assert.equal(sent[1].max_tokens, 16000, 'the cap is unchanged');
  assert.equal(sent[1].reasoning_effort, 'low');
  assert.equal(out.retry?.reasoningEffort, 'low');
  assert.equal(out.retry?.firstReasoningTokens, 16000);
});

test('a runaway that is ALREADY at low effort and at the biggest cap has nothing left to change: the precise failure at once', async () => {
  limits(300);
  gateway([reasoningOnly(300), answer()]);
  await assert.rejects(ask(300, 'sovereign-strong', 'low'), ReasoningBudgetExhaustedError);
  assert.equal(sent.length, 1);
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

test('at the model\'s max output with no effort set: the one retry only lowers the effort (same cap)', async () => {
  limits(300);
  gateway([reasoningOnly(300), answer()]);
  const out = await ask(300);
  assert.equal(out.content, 'the report');
  assert.deepEqual([sent[1].max_tokens, sent[1].reasoning_effort], [300, 'low']);
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

// ---- the streamed path and the assistant caller go through the same rule ----

test('a streamed reply that is only reasoning is recognised as reasoning-exhausted (reasoning_content deltas are kept out of content)', async () => {
  const { assembleStream } = await import('@core/runtime/llm-stream');
  const sse = [
    { choices: [{ delta: { reasoning_content: 'thinking ' } }] },
    { choices: [{ delta: { reasoning_content: 'more' }, finish_reason: 'length' }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 300, total_tokens: 305, completion_tokens_details: { reasoning_tokens: 300 } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const body = new Response(sse).body!;
  const tokens: string[] = [];
  const c = await assembleStream(body, { message: parseLlmMessage, usage: parseLlmUsage }, (t) => tokens.push(t));
  assert.equal(c.content, '');
  assert.deepEqual(tokens, [], 'reasoning is never streamed to the user as the answer');
  assert.equal(c.reasoning?.chars, 'thinking more'.length);
  assert.equal(isReasoningExhausted(c), true);
});

test('the assistant caller (escalate / assistantComplete) retries once larger, then fails precisely', async () => {
  const { liteLlmAssistantCaller } = await import('@core/runtime/complete');
  limits(8000);
  gateway([reasoningOnly(300), answer('assistant answer')]);
  const caller = liteLlmAssistantCaller();
  assert.equal(await caller({ model: 'sovereign-strong', messages: [{ role: 'user', content: 'x' }] }), 'assistant answer');
  assert.equal(sent[0].max_tokens, undefined, 'the first call is unchanged');
  assert.equal(sent[1].max_tokens, 8000, 'the retry asks for the model max output');
  assert.equal(sent[1].reasoning_effort, 'low', 'and for less thinking');
  gateway([reasoningOnly(300), reasoningOnly(8000)]);
  await assert.rejects(caller({ model: 'sovereign-strong', messages: [{ role: 'user', content: 'x' }] }), /spent its whole output budget on reasoning \(8000 tokens\); raise the output limit for sovereign-strong\/kimi-k3\.1-pro/);
});

test('NEGATIVE TWIN: the assistant caller leaves a normal answer and a plain empty one alone', async () => {
  const { liteLlmAssistantCaller } = await import('@core/runtime/complete');
  gateway([{ choices: [{ finish_reason: 'stop', message: { content: 'fine' } }] }]);
  assert.equal(await liteLlmAssistantCaller()({ model: 'sovereign-strong', messages: [{ role: 'user', content: 'x' }] }), 'fine');
  assert.equal(sent.length, 1);
  gateway([{ choices: [{ finish_reason: 'length', message: { content: '' } }] }]);
  assert.equal(await liteLlmAssistantCaller()({ model: 'sovereign-strong', messages: [{ role: 'user', content: 'x' }] }), '');
  assert.equal(sent.length, 1);
});

test('the chat loop (runAgentic) fails with the precise reason rather than answering with nothing', async () => {
  const { runAgentic } = await import('@core/runtime/agentic');
  await assert.rejects(
    runAgentic({
      system: 's', userMessages: [{ role: 'user', content: 'go' }], tools: [], callTool: async () => ({ text: '', isError: false }),
      llm: async (req) => (/plan/i.test(JSON.stringify(req.messages)) && !req.tools ? { content: 'plan', toolCalls: [] } : { content: '', toolCalls: [], finishReason: 'length', reasoning: { chars: 99 }, usage: { input: 1, output: 300, total: 301, reasoning: 300 } }),
      planModel: 'sovereign-strong', actModel: 'sovereign-strong', maxIterations: 3, budget: 20000, maxOutputTokens: 300,
    } as never),
    /spent its whole output budget on reasoning \(300 tokens\)/,
  );
});

// ---- reasoning_effort: an explicit, opt-in switch ----

test('reasoning_effort goes into the request only when asked for', async () => {
  gateway([answer()]);
  await liteLlmCaller()({ model: 'sovereign-strong', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' });
  assert.equal(sent[0].reasoning_effort, 'low');
  gateway([answer()]);
  await liteLlmCaller()({ model: 'sovereign-strong', messages: [{ role: 'user', content: 'x' }] });
  assert.equal('reasoning_effort' in sent[0], false);
});

test('configuredReasoningEfforts: per step kind, low/medium/high only; anything else is off, with a warning', async () => {
  const { configuredReasoningEfforts } = await import('@core/runtime/reasoning-budget');
  const warns: string[] = [];
  const w = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    assert.deepEqual(configuredReasoningEfforts({ MODEL_REASONING_EFFORT_ACT: 'low', MODEL_REASONING_EFFORT_PLAN: ' Medium ', MODEL_REASONING_EFFORT_FINAL: 'high' }), { act: 'low', plan: 'medium', final: 'high' });
    assert.deepEqual(configuredReasoningEfforts({}), {}, 'off by default');
    assert.deepEqual(configuredReasoningEfforts({ MODEL_REASONING_EFFORT_ACT: 'maximum' }), {});
    assert.ok(warns.some((x) => /MODEL_REASONING_EFFORT_ACT/.test(x)));
  } finally { console.warn = w; }
});
