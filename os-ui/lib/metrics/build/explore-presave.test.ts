/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * #142 — the PRE-SAVE preview decision logic in exploreMetric:
 *
 *   • UNSAVED draft + live  → the preview NEVER queries Cube for a member that can't
 *     exist yet; it runs the computed SQL through the governed Trino path (queryRun)
 *     under the viewer's delegated identity, labelled 'live (sql)';
 *   • saved + delivered     → the existing Cube path, unchanged ('live');
 *   • unsaved rolling window → no faithful plain-SQL form: honest pending, no rows
 *     fabricated, and STILL no Cube query.
 *
 * We stub the governed helpers (record calls, no network) and force live mode.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { goldSales } from '../fixtures.ts';
import { claimsFromUser, delegate } from '../../data/identity.ts';
import { previewTrinoSql, sqlRowsToExploreRows, exploreSpec } from '../explorer.ts';

const calls: { queryRun: { sql: string; principal?: string }[]; cubeLoad: number } = { queryRun: [], cubeLoad: 0 };

mock.module('@/lib/infra/governed', {
  namedExports: {
    queryRun: async (sql: string, principal?: string) => {
      calls.queryRun.push({ sql, principal });
      return { engine: 'trino', tables: [], columns: ['revenue'], rows: [['123.5']], rowCount: 1 };
    },
    cubeLoad: async () => {
      calls.cubeLoad++;
      return { rows: [{ 'Sales.revenue': 999 }], annotation: {} };
    },
  },
});

mock.module('./live-clients.ts', {
  namedExports: {
    liveMetricsReachable: async () => true, // force LIVE
    isCubeSyncLag: (e: unknown) => /not found/i.test((e as Error)?.message ?? ''),
  },
});

const { exploreMetric } = await import('./explore-server.ts');

function domainToken() {
  const claims = claimsFromUser({ id: 'amir', domains: ['sales'], role: 'domain_admin', attributes: { region: 'DE' } });
  return delegate(claims, 'domain');
}

test('UNSAVED draft → governed SQL path: queryRun under the viewer, mode live (sql), NO Cube query', async () => {
  calls.queryRun = []; calls.cubeLoad = 0;
  const dataset = goldSales();
  const measure = dataset.measures[0]; // revenue (sum of net_amount)
  const r = await exploreMetric(dataset, measure, domainToken(), {}, { unsaved: true });

  assert.equal(r.mode, 'live (sql)', 'honestly labelled as the SQL preview, not Cube-served');
  assert.equal(calls.cubeLoad, 0, 'Cube is NEVER queried for a member that cannot exist yet');
  assert.equal(calls.queryRun.length, 1, 'exactly one governed Trino query');
  assert.equal(calls.queryRun[0].principal, 'amir', "runs under the VIEWER's delegated identity (R3)");
  assert.match(calls.queryRun[0].sql, /SUM\(net_amount\)/);
  assert.match(calls.queryRun[0].sql, /iceberg\.sales\.gold_sales/, 'reads the gold mart directly');
  assert.equal(r.sql, calls.queryRun[0].sql, 'the surfaced SQL is the SQL that actually ran');
  // Rows come back in the SAME member-keyed shape the Cube path returns.
  assert.deepEqual(r.rows, [{ 'Sales.revenue': 123.5 }]);
  assert.equal(r.pending, undefined, 'a computable preview genuinely completes');
});

test('saved + delivered (default) → the Cube path, unchanged', async () => {
  calls.queryRun = []; calls.cubeLoad = 0;
  const dataset = goldSales();
  const r = await exploreMetric(dataset, dataset.measures[0], domainToken());

  assert.equal(r.mode, 'live');
  assert.equal(calls.cubeLoad, 1, 'resolved via governed Cube');
  assert.equal(calls.queryRun.length, 0, 'no Trino detour once Cube serves the member');
  assert.deepEqual(r.rows, [{ 'Sales.revenue': 999 }]);
});

test('UNSAVED rolling window → honest pending (no SQL form, still no Cube query, no fake rows)', async () => {
  calls.queryRun = []; calls.cubeLoad = 0;
  const dataset = goldSales();
  const measure = { ...dataset.measures[0], rollingWindow: { trailing: '7 day', offset: 'end' as const } };
  const r = await exploreMetric(dataset, measure, domainToken(), {}, { unsaved: true });

  assert.equal(r.pending, true);
  assert.deepEqual(r.rows, []);
  assert.equal(calls.cubeLoad, 0);
  assert.equal(calls.queryRun.length, 0);
});

// ---------------------------------------------------- the pure SQL generator ----

test('previewTrinoSql: aggregations, guided filters and slices compile to one governed SELECT', () => {
  const d = goldSales();
  const spec = exploreSpec(d, d.measures[0], { dimensions: ['region'], timeDimension: 'order_date', granularity: 'month' });
  const sql = previewTrinoSql(d, d.measures[0], spec)!;
  assert.match(sql, /SELECT "region", date_trunc\('month', "order_date"\) AS "order_date", SUM\(net_amount\) AS "revenue"/);
  assert.match(sql, /FROM iceberg\.sales\.gold_sales/);
  assert.match(sql, /GROUP BY 1, 2/);

  // count needs no column; a guided filter becomes FILTER (WHERE …) with {CUBE}. dropped.
  const count = { name: 'orders', type: 'count' as const, sql: '', filters: [{ sql: "{CUBE}.region = 'DE'" }] };
  const countSql = previewTrinoSql(d, count, exploreSpec(d, count))!;
  assert.match(countSql, /COUNT\(\*\) FILTER \(WHERE region = 'DE'\) AS "orders"/);
});

test('previewTrinoSql: a ratio expands its sibling measures; window shapes return null', () => {
  const d = goldSales({
    measures: [
      { name: 'revenue', type: 'sum', sql: 'net_amount' },
      { name: 'orders', type: 'count', sql: '' },
      { name: 'aov', type: 'number', sql: '1.0 * {revenue} / {orders}' },
    ],
  });
  const aov = d.measures[2];
  const sql = previewTrinoSql(d, aov, exploreSpec(d, aov))!;
  assert.match(sql, /1\.0 \* \(SUM\(net_amount\)\) \/ \(COUNT\(\*\)\) AS "aov"/);

  const rolling = { name: 'r7', type: 'sum' as const, sql: 'net_amount', rollingWindow: { trailing: '7 day' } };
  assert.equal(previewTrinoSql(d, rolling, exploreSpec(d, rolling)), null);
  const ghostRatio = { name: 'bad', type: 'number' as const, sql: '{nope} / {orders}' };
  assert.equal(previewTrinoSql(d, ghostRatio, exploreSpec(d, ghostRatio)), null);
});

test('sqlRowsToExploreRows: SQL columns map onto the SAME member-keyed rows as Cube', () => {
  const d = goldSales();
  const spec = exploreSpec(d, d.measures[0], { dimensions: ['region'] });
  const rows = sqlRowsToExploreRows(['region', 'revenue'], [['DE', '100.5'], ['FR', '50']], spec);
  assert.deepEqual(rows, [
    { 'Sales.region': 'DE', 'Sales.revenue': 100.5 },
    { 'Sales.region': 'FR', 'Sales.revenue': 50 },
  ]);
});
