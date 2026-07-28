/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/metrics/store.ts → listMetrics.
 *
 * A metric IS a measure on a governed dataset, so listMetrics derives entirely from
 * listDatasets (which now narrows every tier). This proves the metric registry inherits
 * that isolation: a metric on a sales dataset is hidden while acting in finance, shown in
 * sales, shown under All Domains, and groups by the dataset's visibility tier.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetStore, createDataset, buildVersion, transition, defineMeasure, type Principal } from '../data/store.ts';
import { listMetrics } from './store.ts';

const uAll: Principal = { id: 'u1', domains: ['sales', 'finance'], role: 'admin' };
const uSales: Principal = { id: 'u1', domains: ['sales'], role: 'admin' };
const uFinance: Principal = { id: 'u1', domains: ['finance'], role: 'admin' };

beforeEach(() => __resetStore());

/** A Gold sales dataset promoted to a chosen tier with a `revenue` measure. Returns metricId. */
function seedMetric(tier: 1 | 2): string {
  const d = createDataset(uAll, { name: `M-${tier}`, domain: 'sales' });
  buildVersion(d.id, uAll, 'bronze', { quality: 'passing', artifact: 'bronze/x.dlt.yml' });
  buildVersion(d.id, uAll, 'silver', { quality: 'passing', artifact: 'silver/x.sql' });
  buildVersion(d.id, uAll, 'gold', { quality: 'passing', artifact: 'gold/x.sql' });
  transition(d.id, uAll, 'promote'); // dataset → asset (Domain — cube-deliverable)
  defineMeasure(d.id, uAll, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  if (tier >= 2) transition(d.id, uAll, 'certify', { visibility: 'shared' }); // asset → product (Company)
  return `${d.id}.revenue`;
}

function has(u: Principal, mid: string) {
  const g = listMetrics(u);
  return new Set([...g.mine, ...g.domain, ...g.marketplace].map((m) => m.id)).has(mid);
}

for (const [label, tier] of [['Domain', 1], ['Company', 2]] as const) {
  test(`${label} metric in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const mid = seedMetric(tier);
    assert.ok(!has(uFinance, mid), `${label} sales metric HIDDEN in finance`);
    assert.ok(has(uSales, mid), `${label} sales metric SHOWN in sales`);
    assert.ok(has(uAll, mid), `${label} sales metric SHOWN under All Domains`);
  });
}

test('metric groups by the dataset visibility tier: Domain→domain, Company→marketplace', () => {
  const domainMid = seedMetric(1);
  const companyMid = seedMetric(2);
  const g = listMetrics(uSales);
  assert.ok(g.domain.some((m) => m.id === domainMid), 'Domain metric under Domain');
  assert.ok(g.marketplace.some((m) => m.id === companyMid), 'Company metric under Company');
});
