/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The dbt metric type, the time-grain floor, the null-safe ratio and the typed refusal
 * USER STORY: As a client I want to know what dbt type a metric is and the finest grain it can be
 *             sliced at before I query it; as a viewer I want a zero denominator to show "—" rather
 *             than failing the whole panel; and when the OS cannot serve a shape I want to be TOLD
 *             which shape and why (checklist M5, M6, M-R2.4, M-R4.3, M-R9.5).
 * ARCHITECTURE:
 *   - Pure: literal `Dataset` / `Measure` fixtures, no store, no cluster, no Trino.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbtMetricType, metricTimeGrain, measureMember } from '@tabs/metrics/lib/model';
import { exploreSpec, previewTrinoSql, serveRefusal } from '@tabs/metrics/lib/explorer';

// The `Dataset` / `Measure` types are taken THROUGH the functions under test rather than imported
// from `@tabs/data`: a tab may import only `@core/*` and itself, and `scripts/check-structure.mjs`
// ratchets that count, so a test fixture must not be the thing that grows it.
type Dataset = Parameters<typeof exploreSpec>[0];
type Measure = Parameters<typeof exploreSpec>[1];

const LAYER = { built: true, passThrough: false, quality: 'unknown' as const, updatedAt: '2026-11-14T00:00:00.000Z', artifact: null };

function ds(measures: Measure[], columns?: { name: string; description: string }[]): Dataset {
  const versions = { bronze: { ...LAYER }, silver: { ...LAYER }, gold: { ...LAYER } };
  return {
    version: '1',
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    description: 'Orders.',
    versions,
    grants: [],
    measures,
    columns: columns ?? [
      { name: 'order_id', description: 'Key' },
      { name: 'order_date', description: 'Date' },
      { name: 'region', description: 'Region' },
      { name: 'net_amount', description: 'Amount' },
    ],
  } as Dataset;
}

test('M-R9.5: every OS measure maps to the dbt metric type it is emitted as', () => {
  assert.equal(dbtMetricType({ name: 'r', type: 'sum', sql: 'net_amount' }), 'simple');
  assert.equal(dbtMetricType({ name: 'o', type: 'count', sql: '' }), 'simple');
  assert.equal(dbtMetricType({ name: 'v', type: 'count_distinct_approx', sql: 'x' }), 'simple');
  assert.equal(dbtMetricType({ name: 'a', type: 'number', sql: '1.0 * {r} / {o}' }), 'ratio');
  assert.equal(dbtMetricType({ name: 'm', type: 'number', sql: '({r} - {c}) / {o}' }), 'derived');
  assert.equal(dbtMetricType({ name: 't', type: 'sum', sql: 'net_amount', rollingWindow: { trailing: '7 day' } }), 'cumulative');
  // A window over a ratio is still cumulative — the window decides.
  assert.equal(dbtMetricType({ name: 'w', type: 'number', sql: '1.0 * {r} / {o}', rollingWindow: { trailing: 'unbounded' } }), 'cumulative');
});

test('M-R4.3/M-R9.5: the grain floor is `day` when a time dimension exists, and absent when none does', () => {
  assert.equal(metricTimeGrain(ds([])), 'day');
  assert.equal(
    metricTimeGrain(ds([], [{ name: 'order_id', description: 'Key' }, { name: 'net_amount', description: 'Amount' }])),
    null,
    'no time column ⇒ no time slice is available at all',
  );
});

test('M-R2.4: a ratio`s denominator is NULLIF-wrapped — a zero denominator is NULL ("—"), never a Trino error', () => {
  const d = ds([
    { name: 'revenue', type: 'sum', sql: 'net_amount' },
    { name: 'orders', type: 'count', sql: '' },
    { name: 'aov', type: 'number', sql: '1.0 * {revenue} / {orders}' },
  ]);
  const aov = d.measures[2];
  const sql = previewTrinoSql(d, aov, exploreSpec(d, aov), 'iceberg.sales.gold_orders')!;
  assert.match(sql, /\/ NULLIF\(\(COUNT\(\*\)\), 0\)/);
  assert.doesNotMatch(sql, /\/ \(COUNT\(\*\)\)(?! )/);
});

test('M-R2.4: a composite formula`s divisor is wrapped too, and a non-divisor reference is not', () => {
  const d = ds([
    { name: 'revenue', type: 'sum', sql: 'net_amount' },
    { name: 'cost', type: 'sum', sql: 'net_amount' },
    { name: 'orders', type: 'count', sql: '' },
    { name: 'margin', type: 'number', sql: '({revenue} - {cost}) / {orders}', formula: '([revenue]-[cost])/[orders]' },
  ]);
  const margin = d.measures[3];
  const sql = previewTrinoSql(d, margin, exploreSpec(d, margin), 'iceberg.sales.gold_orders')!;
  assert.match(sql, /\/ NULLIF\(\(COUNT\(\*\)\), 0\)/);
  // The numerator's references are NOT wrapped — only a divisor can divide by zero.
  assert.match(sql, /\(\(SUM\(CAST\(net_amount AS double\)\)\) - \(SUM\(CAST\(net_amount AS double\)\)\)\)/);
});

test('M6: a shape the OS compiler cannot serve is a TYPED, NAMED refusal — and a servable one is not', () => {
  const d = ds([
    { name: 'revenue', type: 'sum', sql: 'net_amount' },
    { name: 'revenue_t7d', type: 'sum', sql: 'net_amount', rollingWindow: { trailing: '7 day', offset: 'end' } },
  ]);
  const plain = d.measures[0];
  assert.equal(serveRefusal(d, plain, exploreSpec(d, plain)), null, 'a simple metric is served, not refused');

  const window = d.measures[1];
  const noTime = serveRefusal(d, window, exploreSpec(d, window))!;
  assert.equal(noTime.code, 'window_needs_time_dimension');
  assert.equal(noTime.metricType, 'cumulative');
  assert.match(noTime.reason, /dbt `cumulative` metric/);

  const spec = exploreSpec(d, window, { timeDimension: 'order_date', granularity: 'month' });
  const mismatch = serveRefusal(d, window, spec)!;
  assert.equal(mismatch.code, 'window_grain_mismatch');
  assert.match(mismatch.reason, /must be 'day', not 'month'/);
  assert.match(mismatch.reason, /will not return a number computed over the wrong unit/);
  assert.equal(previewTrinoSql(d, window, spec, 'x'), null, 'and no SQL is produced for it');

  // At the matching grain it IS served — the refusal is about the grain, not about cumulative.
  const matched = exploreSpec(d, window, { timeDimension: 'order_date', granularity: 'day' });
  assert.equal(serveRefusal(d, window, matched), null);
  assert.ok(previewTrinoSql(d, window, matched, 'iceberg.sales.gold_orders'));
});

test('M6: a ratio whose input no longer resolves refuses with the dbt type named, not a zero', () => {
  const d = ds([{ name: 'broken', type: 'number', sql: '1.0 * {gone} / {missing}' }]);
  const broken = d.measures[0];
  const r = serveRefusal(d, broken, exploreSpec(d, broken))!;
  assert.equal(r.code, 'unservable_shape');
  assert.equal(r.metricType, 'ratio');
  assert.match(r.reason, /references another metric the OS compiler cannot resolve/);
});

test('M-R8.2: the member is frozen across a rename — only the label moves', () => {
  const d = ds([{ name: 'revenue', type: 'sum', sql: 'net_amount', label: 'Net Revenue (EUR)' }]);
  assert.equal(measureMember(d, d.measures[0]), 'Orders.revenue');
});
