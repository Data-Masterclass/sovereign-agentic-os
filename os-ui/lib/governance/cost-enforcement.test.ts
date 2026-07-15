/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { __resetCost, setCap, addSpend } from './cost.ts';

/**
 * Cost enforcement is WIRED into the real assistant chokepoint
 * (lib/assistant/complete.ts → assistantComplete), the single helper every
 * built-in assistant calls. A cap that is already at/over its ceiling BLOCKS the
 * completion (the model is never called); within-cap requests pass through.
 *
 * The assistant model resolver reads Platform Admin config; we mock it so the
 * test stays offline. The gateway transport is injected (never hit).
 */
mock.module('@/lib/platform-admin/models', {
  namedExports: { getAssistantModel: () => ({ id: 'test-model' }) },
});

let assistantComplete: typeof import('../assistant/complete.ts').assistantComplete;
let CostCapExceededError: typeof import('../assistant/complete.ts').CostCapExceededError;

beforeEach(async () => {
  __resetCost();
  const mod = await import('../assistant/complete.ts');
  assistantComplete = mod.assistantComplete;
  CostCapExceededError = mod.CostCapExceededError;
});

const CALLER = async () => 'ok';

test('within a domain cap → completion runs', async () => {
  setCap({ scope: 'domain', subject: 'sales', limit: 100, createdBy: 'admin' });
  addSpend('domain', 'sales', 10);
  const res = await assistantComplete(
    [{ role: 'user', content: 'hi' }],
    { user: { id: 'bea', domains: ['sales'], role: 'creator' }, caller: CALLER },
  );
  assert.equal(res.content, 'ok');
});

test('over a domain cap → BLOCKED before the model is called', async () => {
  setCap({ scope: 'domain', subject: 'sales', limit: 10, createdBy: 'admin' });
  addSpend('domain', 'sales', 10); // already at the ceiling
  let called = false;
  const spyCaller = async () => { called = true; return 'should not run'; };
  await assert.rejects(
    () => assistantComplete(
      [{ role: 'user', content: 'hi' }],
      { user: { id: 'bea', domains: ['sales'], role: 'creator' }, caller: spyCaller },
    ),
    (e: Error) => e instanceof CostCapExceededError,
  );
  assert.equal(called, false, 'the model transport must NOT be called when over cap');
});

test('a tenant cap blocks even a caller with no domain', async () => {
  setCap({ scope: 'tenant', subject: 'tenant', limit: 5, createdBy: 'admin' });
  addSpend('tenant', 'tenant', 5);
  await assert.rejects(
    () => assistantComplete([{ role: 'user', content: 'hi' }], { user: 'anon', caller: CALLER }),
    (e: Error) => e instanceof CostCapExceededError,
  );
});

test('no cap set → completion runs (enforcement is opt-in)', async () => {
  const res = await assistantComplete(
    [{ role: 'user', content: 'hi' }],
    { user: { id: 'bea', domains: ['sales'], role: 'creator' }, caller: CALLER },
  );
  assert.equal(res.content, 'ok');
});
