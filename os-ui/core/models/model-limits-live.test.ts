/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The held catalog limits follow LiteLLM, are refreshed at most once a minute, and a failed read is loud and keeps the last good table.
 * USER STORY: As a platform admin a remap of a role is followed within a minute, and a gateway blip never silently resets the limits.
 * ARCHITECTURE: `ensureModelLimitsFresh` with an injected IO; the real `/model/info` read is proved in `reasoning-budget.e2e.test.ts`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ensureModelLimitsFresh, __resetModelLimitsClock } from '@core/models/model-limits-live';
import { resetCatalogLimits, catalogLimit } from '@core/models/model-limits';

const rows = (out: number) => [{ model_name: 'kimi', model_info: { max_input_tokens: 256000, max_output_tokens: out } }];
const warnings: string[] = [];
const origWarn = console.warn;
beforeEach(() => { resetCatalogLimits(); __resetModelLimitsClock(); warnings.length = 0; console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); }; });
process.on('exit', () => { console.warn = origWarn; });

test('reads /model/info and the role aliases into the held table', async () => {
  await ensureModelLimitsFresh({ models: async () => ({ ok: true, data: rows(262144) }), aliases: async () => ({ ok: true, data: { 'sovereign-strong': 'kimi' } }) });
  assert.equal(catalogLimit('sovereign-strong')?.maxOutput, 262144);
  assert.equal(catalogLimit('sovereign-strong')?.target, 'kimi');
});

test('refreshed at most once a minute', async () => {
  let reads = 0;
  const io = { models: async () => { reads += 1; return { ok: true as const, data: rows(1000) }; }, aliases: async () => ({ ok: true as const, data: {} }) };
  await ensureModelLimitsFresh(io);
  await ensureModelLimitsFresh(io);
  assert.equal(reads, 1);
});

test('NEGATIVE TWIN: a failed read keeps the last good limits and warns', async () => {
  await ensureModelLimitsFresh({ models: async () => ({ ok: true, data: rows(5000) }), aliases: async () => ({ ok: true, data: {} }) });
  __resetModelLimitsClock();
  await ensureModelLimitsFresh({ models: async () => ({ ok: false, error: 'gateway unreachable' }), aliases: async () => ({ ok: true, data: {} }) });
  assert.equal(catalogLimit('kimi')?.maxOutput, 5000, 'the last good table stays');
  assert.ok(warnings.some((w) => /gateway unreachable/.test(w)), 'the failure is logged, not swallowed');
});
