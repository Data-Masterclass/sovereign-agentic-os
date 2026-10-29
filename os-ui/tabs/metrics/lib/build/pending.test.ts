/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * buildMetric PENDING path: the governed read path is live, but the measure has no number
 * for the build's un-sliced probe — a rolling-window / running-total metric needs a time
 * dimension to compute. The build is then NOT green — but it is a soft PENDING, not a
 * genuine failure: `pending: true`, so the route/UI can say "saved, slice it by time to see
 * the value" instead of throwing a scary error. The metric is persisted regardless (done in
 * the route, before buildMetric).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MetricExplore } from '@tabs/metrics/lib/build/live';
import { goldSales } from '@tabs/metrics/lib/fixtures';
import { claimsFromUser, delegate } from '@tabs/data/lib/identity';

mock.module('./explore-server.ts', { namedExports: { exploreMetric: async () => { throw new Error('not used'); } } });

const { buildMetric } = await import('./server.ts');

// A live read path that compiles the metric but has no number without a time slice.
const pendingExplore: MetricExplore = async () => ({
  rows: [], mode: 'live (sql)', pending: true,
  warning: 'This is a rolling-window / running-total metric — add a time dimension to compute it.',
});

function domainToken() {
  const claims = claimsFromUser({ id: 'amir', domains: ['sales'], role: 'domain_admin', attributes: { region: 'DE' } });
  return delegate(claims, 'domain');
}

test('buildMetric: live + measure has no un-sliced number → pending (not a hard failure)', async () => {
  const dataset = goldSales();
  const measure = dataset.measures[0];
  const report = await buildMetric(dataset, measure, domainToken(), { explore: pendingExplore });
  assert.equal(report.mode, 'live');
  assert.equal(report.ok, false, 'not green — the measure did not resolve yet');
  assert.equal(report.pending, true, 'needs a time slice, not a genuine failure');
  assert.match(report.rows[0].error ?? '', /did not resolve yet/);
});

test('buildMetric: an unreachable lakehouse is a FAILURE (never pending, never a fabricated number)', async () => {
  const dataset = goldSales();
  const report = await buildMetric(dataset, dataset.measures[0], domainToken(), {
    explore: async () => ({ rows: [], mode: 'unavailable', unavailable: true, warning: 'Trino unreachable' }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.pending, undefined);
  assert.match(report.rows[0].error ?? '', /unreachable/);
});
