/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Context and output limits follow the catalog model a role is mapped to.
 * USER STORY: As a platform admin I map `sovereign-strong` to a model; the OS reads that model's
 *             limits from LiteLLM's `/model/info` and sizes input and output from them, with no
 *             hand-set env. An explicit `MODEL_CONTEXT_WINDOWS` still wins.
 * NEGATIVE TWINS: a catalog without limits gives the defaults AND a warning; an override beats the
 *             catalog; a catalog value is never applied to a different model.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { limitsFromModelInfo, buildCatalogLimits, setCatalogLimits, resetCatalogLimits } from '@core/models/model-limits';
import { modelContext, inputBudget, outputCeiling } from '@core/models/context-windows';

const row = (name: string, info: Record<string, unknown>, params: Record<string, unknown> = {}) => ({ model_name: name, litellm_params: { model: `openai/${name}`, ...params }, model_info: info });
const warnings: string[] = [];
const origWarn = console.warn;
beforeEach(() => {
  resetCatalogLimits();
  warnings.length = 0;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
});
process.on('exit', () => { console.warn = origWarn; });

test('limitsFromModelInfo reads max_input_tokens and max_output_tokens (max_tokens only as the output fallback)', () => {
  assert.deepEqual(limitsFromModelInfo({ max_input_tokens: 256000, max_output_tokens: 262144 }), { contextWindow: 256000, maxOutput: 262144 });
  assert.deepEqual(limitsFromModelInfo({ max_input_tokens: 131000, max_tokens: 8192 }), { contextWindow: 131000, maxOutput: 8192 });
  assert.deepEqual(limitsFromModelInfo({ max_output_tokens: 4096, max_tokens: 99999 }), { maxOutput: 4096 });
  assert.deepEqual(limitsFromModelInfo({}), {});
  assert.deepEqual(limitsFromModelInfo({ max_input_tokens: 'lots', max_output_tokens: -1 }), {});
});

test('a role resolves through the alias to the catalog model it is mapped to', () => {
  const t = buildCatalogLimits(
    [row('kimi-k3.1-pro', { max_input_tokens: 256000, max_output_tokens: 262144 }), row('small', { max_input_tokens: 32000, max_output_tokens: 4096 })],
    { 'sovereign-strong': 'kimi-k3.1-pro', 'sovereign-worker': 'small' },
  );
  assert.equal(t['sovereign-strong'].contextWindow, 256000);
  assert.equal(t['sovereign-strong'].target, 'kimi-k3.1-pro');
  assert.equal(t['sovereign-worker'].maxOutput, 4096);
  assert.equal(t['kimi-k3.1-pro'].maxOutput, 262144);
});

test('modelContext follows the catalog for the mapped model: window from max_input_tokens, reserved output an eighth of it, capped at the model max', () => {
  setCatalogLimits(buildCatalogLimits([row('kimi-k3.1-pro', { max_input_tokens: 256000, max_output_tokens: 262144 }), row('small', { max_input_tokens: 32000, max_output_tokens: 2048 })], { 'sovereign-strong': 'kimi-k3.1-pro', 'sovereign-worker': 'small' }));
  const strong = modelContext('sovereign-strong', {});
  assert.equal(strong.contextWindow, 256000);
  assert.equal(strong.reservedOutput, 32000);
  assert.equal(strong.maxOutput, 262144);
  const worker = modelContext('sovereign-worker', {});
  assert.equal(worker.contextWindow, 32000);
  assert.equal(worker.reservedOutput, 2048); // never above what the model can produce
  assert.ok(inputBudget('sovereign-strong', {}) + strong.reservedOutput < strong.contextWindow);
});

test('NEGATIVE TWIN: a catalog entry with no limits falls back to the defaults and says so', () => {
  setCatalogLimits(buildCatalogLimits([row('bare', { mode: 'chat' })], { 'sovereign-strong': 'bare' }));
  const ctx = modelContext('sovereign-strong', {});
  assert.equal(ctx.contextWindow, 200_000);
  assert.equal(ctx.reservedOutput, 8_000);
  assert.ok(warnings.some((w) => /sovereign-strong/.test(w) && /no .*limit|catalog/i.test(w)), `expected a warning, got ${JSON.stringify(warnings)}`);
  const n = warnings.length;
  modelContext('sovereign-strong', {});
  assert.equal(warnings.length, n, 'the same fallback is logged once, not on every call');
});

test('NEGATIVE TWIN: the explicit MODEL_CONTEXT_WINDOWS override beats the catalog', () => {
  setCatalogLimits(buildCatalogLimits([row('kimi-k3.1-pro', { max_input_tokens: 256000, max_output_tokens: 262144 })], { 'sovereign-strong': 'kimi-k3.1-pro' }));
  const ctx = modelContext('sovereign-strong', { 'sovereign-strong': { contextWindow: 64000, reservedOutput: 3000 } });
  assert.equal(ctx.contextWindow, 64000);
  assert.equal(ctx.reservedOutput, 3000);
});

test('NEGATIVE TWIN: one model\'s catalog limits are never applied to another name', () => {
  setCatalogLimits(buildCatalogLimits([row('kimi-k3.1-pro', { max_input_tokens: 256000, max_output_tokens: 262144 })], { 'sovereign-strong': 'kimi-k3.1-pro' }));
  assert.equal(modelContext('sovereign-worker', {}).contextWindow, 128_000);
});

test('several deployments behind one name: the smaller limit wins (the safe one)', () => {
  const t = buildCatalogLimits([row('lb', { max_input_tokens: 200000, max_output_tokens: 16000 }), row('lb', { max_input_tokens: 131000, max_output_tokens: 8192 })], {});
  assert.deepEqual([t.lb.contextWindow, t.lb.maxOutput], [131000, 8192]);
});

test('outputCeiling: the catalog max output, else four times the reserve within a quarter of the window', () => {
  setCatalogLimits(buildCatalogLimits([row('kimi-k3.1-pro', { max_input_tokens: 256000, max_output_tokens: 262144 })], { 'sovereign-strong': 'kimi-k3.1-pro' }));
  assert.equal(outputCeiling('sovereign-strong', {}), 262144);
  assert.equal(outputCeiling('sovereign-worker', {}), 16_000); // 4 x 4000, under 128000/4
});
