/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { config, type ModelPrice } from '../core/config.ts';
import { effectiveModelPrices, setModelPrices, getStoredPrices, _reset } from './model-prices.ts';
import { runCostUsd } from '../agents/build/runtime-contract.ts';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

// The env seed for these tests (MODEL_PRICES_JSON is unset under node --test, so
// config.modelPrices is {}). Patched directly — the store reads it lazily.
const ENV_SEED: Record<string, ModelPrice> = {
  'sovereign-default': { inputPerM: 0.1, outputPerM: 0.4 },
  'sovereign-reasoning': { inputPerM: 0.6, outputPerM: 2.2 },
};
const originalEnvPrices = config.modelPrices;

beforeEach(() => {
  _reset();
  config.modelPrices = { ...ENV_SEED };
});
afterEach(() => {
  _reset();
  config.modelPrices = originalEnvPrices;
});

// ------------------------------------------------------------ resolution order --

test('env seed applies when the store is empty (mirror unreachable in tests → fail-soft)', async () => {
  // No stored prices AND the OpenSearch mirror is unreachable under node --test —
  // this is exactly the fail-soft path: effective = the env seed, nothing thrown.
  const prices = await effectiveModelPrices();
  assert.deepEqual(prices['sovereign-default'], { inputPerM: 0.1, outputPerM: 0.4 });
  assert.deepEqual(prices['sovereign-reasoning'], { inputPerM: 0.6, outputPerM: 2.2 });
});

test('a stored price beats the env seed for the same model; other env entries survive', async () => {
  setModelPrices({ 'sovereign-default': { inputPerM: 1, outputPerM: 3 } }, 'alex');
  const prices = await effectiveModelPrices();
  assert.deepEqual(prices['sovereign-default'], { inputPerM: 1, outputPerM: 3 }, 'stored wins');
  assert.deepEqual(prices['sovereign-reasoning'], { inputPerM: 0.6, outputPerM: 2.2 }, 'env-only entry kept');
});

test('a model in neither store nor env stays UNPRICED — runCostUsd yields undefined, never 0', async () => {
  const prices = await effectiveModelPrices();
  assert.equal(prices['sovereign-mock'], undefined);
  assert.equal(runCostUsd({ input: 100, output: 10 }, ['sovereign-mock'], prices), undefined);
  // A priced model DOES cost through the same book (expected mirrors the formula
  // exactly, so no float-representation surprises).
  assert.equal(
    runCostUsd({ input: 1_000_000, output: 1_000_000 }, ['sovereign-default'], prices),
    (1_000_000 * 0.1 + 1_000_000 * 0.4) / 1_000_000,
  );
});

test('clearing an override (null) falls back to the env seed; clearing an env-less one unprices it', async () => {
  setModelPrices({
    'sovereign-default': { inputPerM: 9, outputPerM: 9 },
    'custom-model': { inputPerM: 5, outputPerM: 5 },
  }, 'alex');
  setModelPrices({ 'sovereign-default': null, 'custom-model': null }, 'alex');
  const prices = await effectiveModelPrices();
  assert.deepEqual(prices['sovereign-default'], { inputPerM: 0.1, outputPerM: 0.4 }, 'env seed again');
  assert.equal(prices['custom-model'], undefined, 'no seed → unpriced');
});

// ------------------------------------------------------------ store semantics --

test('setModelPrices records updatedAt/updatedBy for audit', () => {
  const before = Date.now();
  const doc = setModelPrices({ 'sovereign-default': { inputPerM: 1, outputPerM: 2 } }, 'admin@tenant');
  assert.equal(doc.updatedBy, 'admin@tenant');
  assert.ok(Date.parse(doc.updatedAt) >= before - 1000, 'updatedAt is a fresh ISO timestamp');
  assert.deepEqual(getStoredPrices()?.prices['sovereign-default'], { inputPerM: 1, outputPerM: 2 });
});

test('malformed prices are rejected with 400 (negative / non-finite / empty name)', () => {
  const bad = (patch: Record<string, ModelPrice | null>) =>
    assert.throws(() => setModelPrices(patch, 'alex'), (e: { status?: number }) => e.status === 400);
  bad({ 'sovereign-default': { inputPerM: -1, outputPerM: 1 } });
  bad({ 'sovereign-default': { inputPerM: 1, outputPerM: Number.NaN } });
  bad({ 'sovereign-default': { inputPerM: Number.POSITIVE_INFINITY, outputPerM: 1 } });
  bad({ '  ': { inputPerM: 1, outputPerM: 1 } });
  // Nothing partial was applied.
  assert.equal(getStoredPrices(), null);
});

// --------------------------------------------------- route + consumer tripwires --
// Next route handlers cannot be imported under `node --test` (they pull `next`),
// so — like lib/security-route-guards.test.ts — assert the gates are wired in
// source. adminCtx → requireAdmin → 401 anon / 403 non-admin.

test('the prices route is admin-gated (adminCtx on GET+PATCH) and audited', () => {
  const src = read('app/api/platform-admin/models/prices/route.ts');
  assert.match(src, /export async function GET/);
  assert.match(src, /export async function PATCH/);
  const gates = src.match(/await adminCtx\(\)/g) ?? [];
  assert.ok(gates.length >= 2, 'both GET and PATCH call adminCtx (401/403 for non-admins)');
  assert.match(src, /audit\(/, 'price changes are audited (updatedBy trail)');
});

test('cost consumers price runs from effectiveModelPrices(), not the raw env map', () => {
  for (const p of ['lib/agents/build/server.ts', 'lib/agents/build/agentic-graph-server.ts']) {
    const src = read(p);
    assert.match(src, /effectiveModelPrices\(\)/, `${p} resolves the effective price book`);
    assert.doesNotMatch(src, /config\.modelPrices/, `${p} must not read the env seed directly`);
  }
});
