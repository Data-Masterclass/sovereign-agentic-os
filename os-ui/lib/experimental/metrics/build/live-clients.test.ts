/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Fail-soft tests for the REAL Cube client backing the Metric build/preview.
 *
 * A newly-defined measure reaches Cube via the model-sync SIDECAR (polls os-ui's
 * /api/cube/models every few seconds), so for a short window Cube is UP but 400s the
 * measure with "not found for path". That is sync lag, NOT a real error: resolveMeasure
 * must return `null` (not-yet-resolved) and explore must return `{ rows: [] }` — never a
 * hard throw that surfaces a scary 400. Genuine errors still propagate.
 *
 * We stub `@/lib/infra/governed` so cubeScalar/cubeLoad throw the exact Cube error shape,
 * and `@/lib/core/config` so no real Cube URL is needed.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('@/lib/core/config', {
  namedExports: { config: { cubeUrl: 'http://cube.test' } },
});

// Toggle the failure the governed helpers raise per test.
let cubeError: Error | null = null;
mock.module('@/lib/infra/governed', {
  namedExports: {
    cubeScalar: async () => {
      if (cubeError) throw cubeError;
      return 42;
    },
    cubeLoad: async () => {
      if (cubeError) throw cubeError;
      return { rows: [{ 'View.m': 7 }], annotation: {} };
    },
  },
});

const { realMetricCube, isCubeSyncLag, awaitDelivery, measureMembersFromSchema } = await import('./live-clients.ts');

test('isCubeSyncLag: true for a Cube "not found for path" 400, false for real errors', () => {
  assert.equal(
    isCubeSyncLag(new Error("Cube 400: UserError: 'total_sum' not found for path 'V.total_sum'")),
    true,
  );
  assert.equal(isCubeSyncLag(new Error('not found')), true);
  assert.equal(isCubeSyncLag(new Error('Cube 500: internal error')), false);
  assert.equal(isCubeSyncLag(new Error('Could not reach Cube')), false);
});

test('resolveMeasure: returns null (not-yet-resolved) on a sync-lag "not found" error', async () => {
  cubeError = new Error("Cube 400: UserError: 'm' not found for path 'View.m'");
  const v = await realMetricCube().resolveMeasure('View.m');
  assert.equal(v, null);
});

test('resolveMeasure: returns the scalar when the measure IS compiled', async () => {
  cubeError = null;
  const v = await realMetricCube().resolveMeasure('View.m');
  assert.equal(v, 42);
});

test('resolveMeasure: still THROWS a genuine (non-not-found) error', async () => {
  cubeError = new Error('Cube 500: internal server error');
  await assert.rejects(() => realMetricCube().resolveMeasure('View.m'), /500/);
});

test('explore: returns { rows: [] } on a sync-lag "not found" error (soft pending)', async () => {
  cubeError = new Error("Cube 400: 'm' not found for path 'View.m'");
  const { rows } = await realMetricCube().explore({ measures: ['View.m'], dimensions: [], limit: 1 }, { sub: 'a' });
  assert.deepEqual(rows, []);
});

test('explore: still THROWS a genuine error', async () => {
  cubeError = new Error('Could not reach Cube');
  await assert.rejects(
    () => realMetricCube().explore({ measures: ['View.m'], dimensions: [], limit: 1 }, { sub: 'a' }),
    /reach Cube/,
  );
});

// ------------------------------------- reload = bounded await-delivery (#142) ----
// No real sleeps: awaitDelivery takes injectable now/sleep, so the 12 s budget is
// simulated with a fake clock (house style — tests never wait wall-clock time).

test('awaitDelivery: delivered on the first probe — returns immediately, no sleeping', async () => {
  const sleeps: number[] = [];
  const status = await awaitDelivery(async () => true, {
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(status, 'delivered');
  assert.deepEqual(sleeps, [], 'a delivered schema never waits');
});

test('awaitDelivery: delivered after a few polls (sidecar lands mid-budget)', async () => {
  let t = 0;
  const sleeps: number[] = [];
  let probes = 0;
  const status = await awaitDelivery(async () => ++probes >= 3, {
    budgetMs: 12000,
    intervalMs: 2000,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  assert.equal(status, 'delivered');
  assert.equal(probes, 3);
  assert.deepEqual(sleeps, [2000, 2000], 'polled exactly until delivery');
});

test('awaitDelivery: HONEST pending once the ~12 s budget (2 sidecar intervals) is spent', async () => {
  let t = 0;
  const sleeps: number[] = [];
  const status = await awaitDelivery(async () => false, {
    budgetMs: 12000,
    intervalMs: 2000,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  assert.equal(status, 'pending', 'never fabricates delivery');
  assert.equal(sleeps.length, 6, '6 × 2 s = the 12 s budget, then stop — bounded, not forever');
});

test('awaitDelivery: a probe error (Cube genuinely broken) still propagates', async () => {
  await assert.rejects(
    () => awaitDelivery(async () => { throw new Error('Could not reach Cube'); }),
    /reach Cube/,
  );
});

test('measureMembersFromSchema: the measures a schema declares, as View members', () => {
  const schema = [
    'cubes:',
    '  - name: sales',
    '    sql_table: iceberg.sales.gold_sales',
    '    measures:',
    '      - name: revenue',
    '        type: sum',
    '        sql: net_amount',
    '      - name: orders',
    '        type: count',
    '    dimensions:',
    '      - name: region',
    '        sql: region',
    '        type: string',
    '',
    'views:',
    '  - name: Sales',
    '    cubes:',
    '      - join_path: sales',
    '        includes: [revenue, orders, region]',
  ].join('\n');
  assert.deepEqual(measureMembersFromSchema(schema, 'Sales'), ['Sales.revenue', 'Sales.orders']);
  assert.deepEqual(measureMembersFromSchema('not: [valid', 'Sales'), [], 'malformed schema → empty, never a throw');
});

test('reload: returns once every schema measure RESOLVES (delivered on first probe)', async () => {
  cubeError = null; // cubeScalar resolves 42 ⇒ delivered immediately, no waiting
  await realMetricCube().reload('View', 'cubes:\n  - name: v\n    measures:\n      - name: m\n        type: count\n');
});

test('reload: a genuine Cube error (unreachable) still throws ⇒ ✗, never a false ✓', async () => {
  cubeError = new Error('Could not reach Cube');
  await assert.rejects(
    () => realMetricCube().reload('View', 'cubes:\n  - name: v\n    measures:\n      - name: m\n        type: count\n'),
    /reach Cube/,
  );
});
