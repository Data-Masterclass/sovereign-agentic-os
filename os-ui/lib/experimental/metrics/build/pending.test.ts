/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * buildMetric PENDING path: when Cube is reachable (live) but the just-defined measure
 * hasn't been sync'd by the model-sync sidecar yet, resolveMeasure returns null (we
 * fail-soft the "not found for path" 400). The build is then NOT green — but it is a
 * SYNC-LAG pending, not a genuine failure: `pending: true`, so the route/UI can say
 * "saved, value appears shortly" instead of throwing a scary error. The metric is
 * persisted regardless (done in the route, before buildMetric).
 *
 * We force live mode and inject a "reachable but measure-not-yet-compiled" Cube client
 * by stubbing ./live-clients.ts.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MetricCubeClient } from './live.ts';
import { goldSales } from '../fixtures.ts';
import { claimsFromUser, delegate } from '../../data/identity.ts';

// A live Cube that is UP (reload ok) but does NOT know the measure yet (sidecar lag):
// resolveMeasure → null, explore → no rows. Exactly the fail-soft outputs.
const syncLagClient: MetricCubeClient = {
  async reload() { /* Cube /meta is up */ },
  async resolveMeasure() { return null; },
  async explore() { return { rows: [] }; },
};

mock.module('./live-clients.ts', {
  namedExports: {
    liveMetricsReachable: async () => true, // force LIVE
    makeRealMetricClients: () => ({ cube: syncLagClient }),
  },
});

const { buildMetric } = await import('./server.ts');

function domainToken() {
  const claims = claimsFromUser({ id: 'amir', domains: ['sales'], role: 'domain_admin', attributes: { region: 'DE' } });
  return delegate(claims, 'domain');
}

test("buildMetric: live + measure not yet sync'd → pending (not a hard failure)", async () => {
  const dataset = goldSales();
  const measure = dataset.measures[0];
  const report = await buildMetric(dataset, measure, domainToken());
  assert.equal(report.mode, 'live');
  assert.equal(report.ok, false, 'not green — the measure did not resolve yet');
  assert.equal(report.pending, true, 'sync lag, not a genuine failure');
});
