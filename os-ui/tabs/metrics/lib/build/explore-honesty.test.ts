/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every honesty field `exploreMetric` can produce actually reaches its caller
 * USER STORY: As a client of the metric read path I want a refusal, a dropped slice member, an
 *             outage and a query-tool row clip to each arrive WITH a reason — a result that is
 *             empty for a reason I am not told is indistinguishable from a genuine zero
 *             (review C-10, H-2, M-4).
 * ARCHITECTURE:
 *   - Drives the real `exploreMetric` with the governed query path MOCKED at the module boundary,
 *     so what is asserted is the function's own composition of the result and not a re-statement
 *     of it. `liveMetricsReachable` is mocked live so the SQL branch is the one under test.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { goldSales, viewerToken } from '@tabs/metrics/lib/fixtures';

type QueryResult = { engine: string; tables: string[]; columns: string[]; rows: string[][]; rowCount: number; truncated?: boolean; rowLimit?: number; message?: string };
let nextResult: QueryResult = { engine: 'trino', tables: [], columns: [], rows: [], rowCount: 0 };

mock.module('@core/infra/governed', {
  namedExports: {
    queryRun: async () => nextResult,
    queryToolReachable: async () => true,
  },
});
mock.module('./live-clients.ts', { namedExports: { liveMetricsReachable: async () => true } });

const { exploreMetric } = await import('./explore-server.ts');

const token = viewerToken;

test('C-10: the query tool`s OWN row clip is passed through — it is lower than the slice LIMIT', async () => {
  const d = goldSales();
  nextResult = {
    engine: 'trino',
    tables: ['iceberg.sales.gold_sales'],
    columns: ['revenue'],
    rows: [['42']],
    rowCount: 1,
    truncated: true,
    rowLimit: 1,
    message: 'Result clipped at the query tool ceiling of 1 row; the rows are the first 1, not a sample.',
  };
  const r = await exploreMetric(d, d.measures[0], token(), {});
  // These three used to be dropped here, so a consumer that summed the rows presented a total over
  // an unknown fraction of the groups with nothing to warn it.
  assert.equal(r.truncated, true);
  assert.equal(r.rowLimit, 1);
  assert.match(r.message ?? '', /clipped at the query tool ceiling/);
  assert.equal(r.mode, 'live (sql)');
});

test('C-10: an un-clipped result carries none of the three fields (absent, not false)', async () => {
  const d = goldSales();
  nextResult = { engine: 'trino', tables: [], columns: ['revenue'], rows: [['42']], rowCount: 1 };
  const r = await exploreMetric(d, d.measures[0], token(), {});
  assert.equal('truncated' in r, false);
  assert.equal('rowLimit' in r, false);
  assert.equal('message' in r, false);
});

test('M6: a refused slice returns the TYPED refusal and no rows', async () => {
  const d = goldSales();
  const windowed = { ...d.measures[0], name: 'revenue_t7d', rollingWindow: { trailing: '7 day', offset: 'end' as const } };
  const dataset = { ...d, measures: [...d.measures, windowed] };
  const r = await exploreMetric(dataset, windowed, token(), {});
  assert.equal(r.pending, true);
  assert.deepEqual(r.rows, []);
  assert.equal(r.refusal?.code, 'window_needs_time_dimension');
  assert.equal(r.refusal?.metricType, 'cumulative');
  assert.equal(r.warning, r.refusal?.reason, 'the prose and the typed reason are the same sentence');
});

test('M-4: a SERVED cumulative result warns that the frame counts buckets, not calendar units', async () => {
  const d = goldSales();
  const windowed = { ...d.measures[0], name: 'revenue_t7d', rollingWindow: { trailing: '7 day', offset: 'end' as const } };
  const dataset = { ...d, measures: [...d.measures, windowed] };
  nextResult = { engine: 'trino', tables: [], columns: ['order_date', 'revenue_t7d'], rows: [['2026-01-01', '42']], rowCount: 1 };
  const r = await exploreMetric(dataset, windowed, token(), { timeDimension: 'order_date', granularity: 'day' });
  assert.equal(r.pending, undefined, 'at a matching grain it IS served');
  assert.match(r.warning ?? '', /counts time BUCKETS, not calendar units/);
  assert.match(r.warning ?? '', /os_time_spine_day\.sql/);
});

test('M-4: a running total says what it accumulates; a non-window metric carries no caveat at all', async () => {
  const d = goldSales();
  const running = { ...d.measures[0], name: 'revenue_rt', rollingWindow: { trailing: 'unbounded' } };
  const dataset = { ...d, measures: [...d.measures, running] };
  nextResult = { engine: 'trino', tables: [], columns: ['order_date', 'revenue_rt'], rows: [['2026-01-01', '42']], rowCount: 1 };
  const r = await exploreMetric(dataset, running, token(), { timeDimension: 'order_date', granularity: 'day' });
  assert.match(r.warning ?? '', /Running total/);

  nextResult = { engine: 'trino', tables: [], columns: ['revenue'], rows: [['42']], rowCount: 1 };
  const plain = await exploreMetric(d, d.measures[0], token(), {});
  assert.equal(plain.warning, undefined, 'a simple metric gets no caveat — the caveat must mean something');
});
