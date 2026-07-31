/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The metric SERVE logic in exploreMetric — metrics→Trino migration (Phase 1). Cube is OFF
 * the metric read path: EVERY metric read (saved + unsaved) is served as one governed Trino
 * SELECT over the TIER-AWARE physical gold mart, run under the viewer's delegated identity
 * (R3), labelled 'live (sql)'. Personal-dataset metrics read the owner's personal lane; a
 * rolling-window measure has no faithful SQL form so it is honest-pending (Phase 2 via Cube).
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
  assert.match(calls.queryRun[0].sql, /SUM\(CAST\(net_amount AS double\)\)/);
  assert.match(calls.queryRun[0].sql, /iceberg\.sales\.gold_sales/, 'reads the gold mart directly');
  assert.equal(r.sql, calls.queryRun[0].sql, 'the surfaced SQL is the SQL that actually ran');
  // Rows come back in the SAME member-keyed shape the Cube path returns.
  assert.deepEqual(r.rows, [{ 'Sales.revenue': 123.5 }]);
  assert.equal(r.pending, undefined, 'a computable preview genuinely completes');
});

test('SAVED metric → ALSO governed SQL now (Cube off the read path): live (sql), no Cube query', async () => {
  // The migration's core behaviour change: a saved metric no longer resolves via Cube; it is
  // served as the SAME governed Trino SELECT as an unsaved draft.
  calls.queryRun = []; calls.cubeLoad = 0;
  const dataset = goldSales();
  const r = await exploreMetric(dataset, dataset.measures[0], domainToken());

  assert.equal(r.mode, 'live (sql)', 'served directly as governed Trino SQL, not via Cube');
  assert.equal(calls.cubeLoad, 0, 'Cube is OFF the metric read path (Phase 1)');
  assert.equal(calls.queryRun.length, 1, 'exactly one governed Trino query');
  assert.match(calls.queryRun[0].sql, /FROM iceberg\.sales\.gold_sales/, 'reads the DOMAIN gold mart');
  assert.deepEqual(r.rows, [{ 'Sales.revenue': 123.5 }]);
});

test('PERSONAL dataset metric → reads the OWNER personal lane, run AS the owner uid', async () => {
  // The migration ENABLES metrics on personal gold: tier "dataset" → the private lane FQN,
  // read under the owner's delegated subject (OPA is_owned_personal grants it).
  calls.queryRun = []; calls.cubeLoad = 0;
  const dataset = goldSales({ tier: 'dataset', visibility: 'private' });
  const r = await exploreMetric(dataset, dataset.measures[0], domainToken());

  assert.equal(r.mode, 'live (sql)');
  assert.equal(calls.cubeLoad, 0);
  assert.equal(calls.queryRun.length, 1);
  assert.match(calls.queryRun[0].sql, /FROM iceberg\.personal_amir\.gold_sales/, 'reads the owner private lane');
  assert.equal(calls.queryRun[0].principal, 'amir', 'runs AS the owner uid (is_owned_personal)');
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
  assert.match(sql, /SELECT "region", date_trunc\('month', "order_date"\) AS "order_date", SUM\(CAST\(net_amount AS double\)\) AS "revenue"/);
  assert.match(sql, /FROM iceberg\.sales\.gold_sales/);
  assert.match(sql, /GROUP BY 1, 2/);

  // count needs no column; a guided filter becomes FILTER (WHERE …) with {CUBE}. dropped.
  const count = { name: 'orders', type: 'count' as const, sql: '', filters: [{ sql: "{CUBE}.region = 'DE'" }] };
  const countSql = previewTrinoSql(d, count, exploreSpec(d, count))!;
  assert.match(countSql, /COUNT\(\*\) FILTER \(WHERE region = 'DE'\) AS "orders"/);
});

test('previewTrinoSql: emits NO SQL comments — the governed query path rejects them', () => {
  // Regression (#preview-comments): a plain row-count preview failed at queryRun with
  // "SQL comments are not allowed on the query path" because the generated SQL carried
  // a `--` header. The EXECUTED preview SQL must be comment-free; dropToSql (display
  // only, never executed) keeps its explanatory comment.
  const d = goldSales();
  const count = { name: 'row_count', type: 'count' as const, sql: '' };
  const sql = previewTrinoSql(d, count, exploreSpec(d, count))!;
  assert.ok(!sql.includes('--'), `executed preview SQL must contain no line comments, got:\n${sql}`);
  assert.ok(!sql.includes('/*'), `executed preview SQL must contain no block comments, got:\n${sql}`);
  assert.match(sql, /^SELECT /, 'starts straight at the SELECT');
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
  assert.match(sql, /1\.0 \* \(SUM\(CAST\(net_amount AS double\)\)\) \/ \(COUNT\(\*\)\) AS "aov"/);

  // A window measure with NO time slice has no series → still null (honest pending).
  const rolling = { name: 'r7', type: 'sum' as const, sql: 'net_amount', rollingWindow: { trailing: '7 day' } };
  assert.equal(previewTrinoSql(d, rolling, exploreSpec(d, rolling)), null);
  const ghostRatio = { name: 'bad', type: 'number' as const, sql: '{nope} / {orders}' };
  assert.equal(previewTrinoSql(d, ghostRatio, exploreSpec(d, ghostRatio)), null);
});

// -------------------------------------------------- window / running-total SQL ----

test('previewTrinoSql: a TRAILING window (last N days) compiles to a bucketed ROWS frame', () => {
  const d = goldSales();
  const r7 = { name: 'r7', type: 'sum' as const, sql: 'net_amount', rollingWindow: { trailing: '7 day', offset: 'end' as const } };
  const spec = exploreSpec(d, r7, { timeDimension: 'order_date', granularity: 'day' });
  const sql = previewTrinoSql(d, r7, spec, 'iceberg.sales.gold_sales')!;
  // Per-bucket base aggregate, then SUM over the trailing 7 buckets (7-1 = 6 preceding).
  assert.match(sql, /date_trunc\('day', "order_date"\) AS "order_date"/);
  assert.match(sql, /SUM\(SUM\(CAST\(net_amount AS double\)\)\) OVER \(ORDER BY date_trunc\('day', "order_date"\) ROWS BETWEEN 6 PRECEDING AND CURRENT ROW\) AS "r7"/);
  assert.match(sql, /GROUP BY 1/);
  assert.ok(!sql.includes('--') && !sql.includes('/*'), 'no comments in executed window SQL');
});

test('previewTrinoSql: a RUNNING TOTAL (trailing unbounded) is a cumulative window', () => {
  const d = goldSales();
  const cum = { name: 'cum_rev', type: 'sum' as const, sql: 'net_amount', rollingWindow: { trailing: 'unbounded' } };
  const spec = exploreSpec(d, cum, { timeDimension: 'order_date', granularity: 'month' });
  const sql = previewTrinoSql(d, cum, spec, 'iceberg.sales.gold_sales')!;
  assert.match(sql, /SUM\(SUM\(CAST\(net_amount AS double\)\)\) OVER \(ORDER BY date_trunc\('month', "order_date"\) ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\) AS "cum_rev"/);
});

test('previewTrinoSql: a window grouped by a dimension PARTITIONs the series', () => {
  const d = goldSales();
  const cum = { name: 'cum_rev', type: 'sum' as const, sql: 'net_amount', rollingWindow: { trailing: 'unbounded' } };
  const spec = exploreSpec(d, cum, { dimensions: ['region'], timeDimension: 'order_date', granularity: 'month' });
  const sql = previewTrinoSql(d, cum, spec, 'iceberg.sales.gold_sales')!;
  assert.match(sql, /OVER \(PARTITION BY "region" ORDER BY date_trunc\('month', "order_date"\)/);
  assert.match(sql, /GROUP BY 1, 2/);
});

test('previewTrinoSql: a window whose unit ≠ the slice granularity is NOT faked → null', () => {
  // A "1 month" trailing window over a DAY-grained slice has no faithful ROWS-frame form
  // (a month is not a fixed number of day-buckets) — honest null, never a wrong number.
  const d = goldSales();
  const m = { name: 'r1m', type: 'sum' as const, sql: 'net_amount', rollingWindow: { trailing: '1 month' } };
  const spec = exploreSpec(d, m, { timeDimension: 'order_date', granularity: 'day' });
  assert.equal(previewTrinoSql(d, m, spec, 'iceberg.sales.gold_sales'), null);
});

test('previewTrinoSql: a window with NO time dimension is null (unusable without a series)', () => {
  const d = goldSales();
  const r7 = { name: 'r7', type: 'sum' as const, sql: 'net_amount', rollingWindow: { trailing: '7 day' } };
  assert.equal(previewTrinoSql(d, r7, exploreSpec(d, r7), 'iceberg.sales.gold_sales'), null);
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
