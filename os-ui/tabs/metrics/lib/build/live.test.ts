/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter, type MetricBuildContext } from '@tabs/metrics/lib/build/adapter';
import { makeMetricAdapters, memberValue, type MetricExplore } from '@tabs/metrics/lib/build/live';
import { measureMember } from '@tabs/metrics/lib/model';
import { goldSales } from '@tabs/metrics/lib/fixtures';
import { claimsFromUser, delegate, propagate } from '@tabs/data/lib/identity';

function ctx(): MetricBuildContext {
  const dataset = goldSales();
  const measure = dataset.measures[0];
  const token = delegate(claimsFromUser({ id: 'amir', domains: ['sales'], role: 'creator', attributes: { region: 'DE' } }), 'domain');
  return { dataset, measure, member: measureMember(dataset, measure), token };
}

/** An in-memory governed read path: one row per region the viewer may see (RLS from the token). */
const rlsExplore: MetricExplore = async (_d, _m, token) => {
  const region = propagate(token).securityContext.region as string | undefined;
  const all = [{ 'Sales.region': 'DE', 'Sales.revenue': 1000 }, { 'Sales.region': 'FR', 'Sales.revenue': 2000 }];
  return { rows: region ? all.filter((r) => r['Sales.region'] === region) : all, mode: 'live (sql)' };
};

test('trino adapter: ✓ only after the governed SQL ran AND the member resolved to a number', async () => {
  const adapters = makeMetricAdapters({ explore: rlsExplore });
  const c = ctx();
  const row = await runAdapter(adapters.trino, c);
  assert.equal(row.status, 'ok', row.error);
  assert.ok(row.applied && row.verified);
  assert.match(row.detail, /'Sales\.revenue' = 1000 via governed Trino SQL/); // the viewer's (DE) rows only
});

test('no false ✓: the member did not resolve to a number → ✗', async () => {
  const adapters = makeMetricAdapters({ explore: async () => ({ rows: [{ 'Sales.revenue': 'n/a' }], mode: 'live (sql)' }) });
  const row = await runAdapter(adapters.trino, ctx());
  assert.equal(row.status, 'fail');
  assert.ok(row.applied && !row.verified);
  assert.match(row.error ?? '', /did not resolve to a number/);
});

test('no false ✓: verify WITHOUT apply never passes (nothing was computed)', async () => {
  const adapters = makeMetricAdapters({ explore: rlsExplore });
  const row = await adapters.trino.verify(ctx());
  assert.equal(row.ok, false);
});

test('an unreachable lakehouse fails apply with the honest outage message', async () => {
  const adapters = makeMetricAdapters({ explore: async () => ({ rows: [], mode: 'unavailable', unavailable: true, warning: 'Trino is unreachable' }) });
  const row = await runAdapter(adapters.trino, ctx());
  assert.equal(row.status, 'fail');
  assert.equal(row.applied, false);
  assert.match(row.error ?? '', /unreachable/);
});

test('memberValue sums the member across rows and refuses non-numeric cells', () => {
  assert.equal(memberValue([{ 'Sales.revenue': 1 }, { 'Sales.revenue': '2' }], 'Sales.revenue'), 3);
  assert.equal(memberValue([{ revenue: 5 }], 'Sales.revenue'), 5); // leaf-keyed rows too
  assert.equal(memberValue([], 'Sales.revenue'), null);
  assert.equal(memberValue([{ 'Sales.revenue': 'x' }], 'Sales.revenue'), null);
});
