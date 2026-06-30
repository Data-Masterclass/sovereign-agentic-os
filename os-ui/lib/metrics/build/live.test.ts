/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter, type MetricBuildContext } from './adapter.ts';
import { makeMockMetricAdapters, newMetricMock } from './mocks.ts';
import { scaffoldCubeYaml } from '../../data/metrics.ts';
import { measureMember } from '../model.ts';
import { goldSales } from '../fixtures.ts';

function ctx(): MetricBuildContext {
  const dataset = goldSales();
  const measure = dataset.measures[0];
  return {
    dataset,
    measure,
    schema: scaffoldCubeYaml(dataset),
    member: measureMember(dataset, measure),
    securityContext: { sub: 'amir', region: 'DE' },
  };
}

test('cube adapter: ✓ only after a real reload + the measure resolves', async () => {
  const backend = newMetricMock();
  const adapters = makeMockMetricAdapters(backend);
  const c = ctx();
  const row = await runAdapter(adapters.cube, c);
  assert.equal(row.status, 'ok', row.error);
  assert.ok(row.applied && row.verified);
});

test('metric-explorer adapter: verify is the consistency proof (explorer == agent)', async () => {
  const backend = newMetricMock();
  const adapters = makeMockMetricAdapters(backend);
  const c = ctx();
  await runAdapter(adapters.cube, c); // load first
  const row = await runAdapter(adapters['metric-explorer'], c);
  assert.equal(row.status, 'ok', row.error);
  assert.match(row.detail, /numbers match/);
});

test('no false ✓: an empty schema fails apply (nothing reloaded)', async () => {
  const backend = newMetricMock();
  const adapters = makeMockMetricAdapters(backend);
  const c = { ...ctx(), schema: '' };
  const row = await runAdapter(adapters.cube, c);
  assert.equal(row.status, 'fail');
  assert.equal(row.applied, false);
});

test('no false ✓: a measure that was never loaded does not resolve', async () => {
  const backend = newMetricMock();
  const adapters = makeMockMetricAdapters(backend);
  // verify the cube adapter WITHOUT applying — resolveMeasure returns null → ✗
  const row = await adapters.cube.verify(ctx());
  assert.equal(row.ok, false);
});
