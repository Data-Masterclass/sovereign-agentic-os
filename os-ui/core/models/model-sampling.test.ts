/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       models
 * FEATURE:    Vendor-recommended sampling per catalog model, on every chat-model call; exceptions keep theirs
 * USER STORY: As the owner each model is called as its maker recommends — in the chat, agent runs, software building
 *             and the builder assistant — and an unknown model keeps 0.2.
 * ARCHITECTURE: the REAL gateway callers (`liteLlmCaller`, the harness door of chat/agents/software; the assistant
 *             caller of the builder) with `fetch` stubbed to read the request body; the role → catalog model resolution
 *             through the real catalog-limits table.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { recommendedSampling, wireSampling, DEFAULT_TEMPERATURE } from '@core/models/model-sampling';
import { buildCatalogLimits, resetCatalogLimits, setCatalogLimits } from '@core/models/model-limits';
import { liteLlmCaller } from '@core/runtime/runtime';
import { liteLlmAssistantCaller } from '@core/runtime/complete';

afterEach(() => resetCatalogLimits());

async function bodyOf(call: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try { await call(); } finally { globalThis.fetch = orig; }
  return body;
}

const row = (name: string) => ({ model_name: name, model_info: { max_input_tokens: 128000, max_output_tokens: 8000 } });

test('every listed catalog model carries the vendor values and an official source', () => {
  assert.deepEqual(wireSampling({ model: 'stackit-gpt-oss-20b' }), { temperature: 1, top_p: 1 });
  assert.deepEqual(wireSampling({ model: 'stackit-qwen3-vl-235b' }), { temperature: 0.7, top_p: 0.8 });
  assert.deepEqual(wireSampling({ model: 'lyceum-kimi-k3.1-pro' }), {}, 'Moonshot fixes it at 1.0 and asks not to send it');
  assert.deepEqual(wireSampling({ model: 'lyceum-deepseek-v4.1-flash' }), { temperature: 1, top_p: 0.95 });
  for (const m of ['stackit-gpt-oss-20b', 'stackit-qwen3-vl-235b', 'lyceum-kimi-k3.1-pro', 'lyceum-deepseek-v4.1-flash']) {
    assert.match(recommendedSampling(m)!.source, /^https:\/\/(github\.com\/(openai|QwenLM)|platform\.kimi\.ai|huggingface\.co\/deepseek-ai)\//);
  }
});

test('a ROLE is sampled as the catalog model it points at', () => {
  setCatalogLimits(buildCatalogLimits([row('stackit-gpt-oss-20b'), row('lyceum-kimi-k3.1-pro')], { 'sovereign-worker': 'stackit-gpt-oss-20b', 'sovereign-strong': 'lyceum-kimi-k3.1-pro' }));
  assert.deepEqual(wireSampling({ model: 'sovereign-worker' }), { temperature: 1, top_p: 1 });
  assert.deepEqual(wireSampling({ model: 'sovereign-strong' }), {});
});

test('TWIN: an unknown model (no published recommendation) keeps 0.2', () => {
  assert.deepEqual(wireSampling({ model: 'some-new-model' }), { temperature: DEFAULT_TEMPERATURE });
  assert.equal(DEFAULT_TEMPERATURE, 0.2);
});

test('EXCEPTIONS keep their own temperature on every model (fixedSampling)', () => {
  assert.deepEqual(wireSampling({ model: 'stackit-gpt-oss-20b', temperature: 0, fixedSampling: true }), { temperature: 0 });
  assert.deepEqual(wireSampling({ model: 'lyceum-kimi-k3.1-pro', temperature: 0.2, fixedSampling: true }), { temperature: 0.2 });
});

test('ON THE WIRE: the harness caller (chat, agent runs, software building) sends the model\'s values, whatever the caller passed', async () => {
  setCatalogLimits(buildCatalogLimits([row('stackit-gpt-oss-20b')], { 'sovereign-worker': 'stackit-gpt-oss-20b' }));
  const agentOrChat = await bodyOf(() => liteLlmCaller({ userId: 'u1', domain: 'sales', tab: 'agents' })({ model: 'sovereign-worker', messages: [{ role: 'user', content: 'x' }], temperature: 0.2 }));
  assert.equal(agentOrChat.temperature, 1);
  assert.equal(agentOrChat.top_p, 1);
  const unknown = await bodyOf(() => liteLlmCaller()({ model: 'some-new-model', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(unknown.temperature, 0.2);
  assert.equal(unknown.top_p, undefined);
  const exception = await bodyOf(() => liteLlmCaller()({ model: 'sovereign-worker', messages: [{ role: 'user', content: 'x' }], temperature: 0, fixedSampling: true }));
  assert.equal(exception.temperature, 0);
  assert.equal(exception.top_p, undefined);
});

test('ON THE WIRE: the builder assistant caller samples the same way; a Kimi call carries no temperature', async () => {
  const kimi = await bodyOf(() => liteLlmAssistantCaller()({ model: 'lyceum-kimi-k3.1-pro', messages: [{ role: 'user', content: 'x' }] }));
  assert.equal('temperature' in kimi, false);
  const qwen = await bodyOf(() => liteLlmAssistantCaller()({ model: 'stackit-qwen3-vl-235b', messages: [{ role: 'user', content: 'x' }] }));
  assert.deepEqual([qwen.temperature, qwen.top_p], [0.7, 0.8]);
});
