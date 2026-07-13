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

const { realMetricCube, isCubeSyncLag } = await import('./live-clients.ts');

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
