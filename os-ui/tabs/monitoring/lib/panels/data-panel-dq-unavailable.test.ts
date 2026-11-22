/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Data panel never shows a stale quality value as live
 * USER STORY: As a dataset owner, when Dagster cannot be reached the Monitoring Data panel says the
 *             test results are unavailable and why — it does not show the last OS ledger run as a
 *             current `tests` figure.
 * ARCHITECTURE: the Data tab's reader is replaced by a stub that returns what `latestDqRuns` now
 *   returns for an unreachable Dagster; the other upstreams are down (reported, not asserted here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerMonitoringSources } = await import('./sources');
const { dataView } = await import('./data-panel');
const user = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;

const base = {
  agentSystems: async () => [],
  datasets: async () => [{ id: 'ds_1', name: 'orders', domain: 'sales', scope: 'mine' as const }],
  syncSchedules: async () => [],
  assetKeys: async () => new Map(),
};

test('Dagster unreachable: tests source is unavailable with the reason; the dataset shows no live tests, only the last value labelled with its time', async () => {
  registerMonitoringSources({
    ...base,
    latestTests: async () => new Map([['ds_1', { source: null, ranAt: null, results: [], unavailable: { reason: 'Dagster: HTTP 503', lastKnown: { ranAt: '2026-11-01T08:00:00.000Z', badge: 'passing' as const, healthScore: 100 } } }]]),
  } as never);
  const v = await dataView(user);
  assert.equal(v.sources.tests.state, 'unavailable');
  assert.match((v.sources.tests as { reason: string }).reason, /HTTP 503/);
  const t = v.datasets[0].tests!;
  assert.equal(t.source, null);
  assert.equal(t.total, 0);
  assert.equal(t.failing.length, 0);
  assert.equal(t.unavailable!.lastKnown!.ranAt, '2026-11-01T08:00:00.000Z');
});

test('twin: a live Dagster record keeps the tests source live and carries no unavailable marker', async () => {
  registerMonitoringSources({
    ...base,
    latestTests: async () => new Map([['ds_1', { source: 'dagster' as const, ranAt: '2026-11-22T06:00:00.000Z', results: [{ id: 'a', label: 'a', status: 'pass', violations: 0 }] }]]),
  } as never);
  const v = await dataView(user);
  assert.equal(v.sources.tests.state, 'live');
  assert.equal(v.datasets[0].tests!.source, 'dagster');
  assert.equal(v.datasets[0].tests!.unavailable, undefined);
});
