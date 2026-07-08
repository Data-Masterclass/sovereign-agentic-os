/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldCubeYaml } from '../data/metrics.ts';
import { goldSales } from './fixtures.ts';
import {
  measureFromForm,
  measureFromYaml,
  sameMeasure,
  filterSql,
  type MetricForm,
} from './model.ts';
import { convergence } from './consistency.ts';

/**
 * The richer Cube measure model exposed through the guided form: filtered measures,
 * count-distinct(-approx), rolling windows / running totals, display format, ratios
 * (derived `number` measures) and drill members — all still ONE canonical Measure that
 * round-trips through the same scaffold→YAML→parse path as a plain measure.
 */

test('a plain form is byte-for-byte the old measure (no rich fields leak in)', () => {
  const m = measureFromForm({ name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] });
  assert.deepEqual(m, { name: 'revenue', type: 'sum', sql: 'net_amount' });
});

test('count_distinct_approx is accepted as an aggregation', () => {
  const m = measureFromForm({ name: 'Buyers', aggregation: 'count_distinct_approx', column: 'customer_id', dimensions: [] });
  assert.equal(m.type, 'count_distinct_approx');
  assert.equal(m.sql, 'customer_id');
});

test('filterSql builds a governed, quoted predicate from a guided filter', () => {
  assert.equal(filterSql({ column: 'status', operator: 'equals', value: 'completed' }), "{CUBE}.status = 'completed'");
  assert.equal(filterSql({ column: 'net_amount', operator: 'gt', value: '100' }), '{CUBE}.net_amount > 100');
  assert.equal(filterSql({ column: 'status', operator: 'set', value: '' }), '{CUBE}.status IS NOT NULL');
});

test('a filtered measure carries the compiled filter onto the Measure', () => {
  const m = measureFromForm({
    name: 'Completed revenue', aggregation: 'sum', column: 'net_amount', dimensions: [],
    filter: { column: 'status', operator: 'equals', value: 'completed' },
  });
  assert.deepEqual(m.filters, [{ sql: "{CUBE}.status = 'completed'" }]);
});

test('a running total compiles to an unbounded trailing rolling window', () => {
  const m = measureFromForm({
    name: 'Cumulative orders', aggregation: 'count', column: '', dimensions: [], runningTotal: true,
  });
  assert.deepEqual(m.rollingWindow, { trailing: 'unbounded' });
});

test('a trailing window compiles amount + unit into a Cube duration', () => {
  const m = measureFromForm({
    name: 'Trailing 7d orders', aggregation: 'count', column: '', dimensions: [],
    rollingWindow: { amount: 7, unit: 'day' },
  });
  assert.deepEqual(m.rollingWindow, { trailing: '7 day', offset: 'end' });
});

test('a ratio builds a derived number measure over two measure references', () => {
  const m = measureFromForm({
    name: 'Conversion rate', aggregation: 'number', column: '', dimensions: [],
    ratio: { numerator: 'purchases', denominator: 'visits' }, format: 'percent',
  });
  assert.equal(m.type, 'number');
  assert.equal(m.sql, '1.0 * {purchases} / {visits}');
  assert.equal(m.format, 'percent');
});

test('format + drill members ride onto the measure', () => {
  const m = measureFromForm({
    name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [],
    format: 'currency', drillMembers: ['order_id', 'region'],
  });
  assert.equal(m.format, 'currency');
  assert.deepEqual(m.drillMembers, ['order_id', 'region']);
});

test('sameMeasure distinguishes measures that differ only in a rich field', () => {
  const base = measureFromForm({ name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] });
  const filtered = measureFromForm({
    name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [],
    filter: { column: 'status', operator: 'equals', value: 'completed' },
  });
  assert.ok(!sameMeasure(base, filtered), 'a filter changes the artifact');
  assert.ok(sameMeasure(filtered, { ...filtered }), 'identical rich measures match');
});

test('a rich measure round-trips through scaffold → YAML → parse (convergence holds)', () => {
  const form: MetricForm = {
    name: 'Completed revenue', aggregation: 'sum', column: 'net_amount', dimensions: [],
    filter: { column: 'status', operator: 'equals', value: 'completed' },
    format: 'currency',
  };
  const m = measureFromForm(form);
  const d = goldSales({ measures: [m] });
  const yaml = scaffoldCubeYaml(d);
  assert.match(yaml, /filters:/);
  assert.match(yaml, /status = 'completed'/);
  assert.match(yaml, /format: currency/);
  const back = measureFromYaml(yaml, 'Completed revenue');
  assert.ok(sameMeasure(m, back), 'YAML round-trips to the same rich measure');
});

test('the define-route convergence gate passes for a rich (filtered) measure', () => {
  const form: MetricForm = {
    name: 'Completed revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'],
    filter: { column: 'status', operator: 'equals', value: 'completed' },
    format: 'currency',
  };
  const m = measureFromForm(form);
  const d = goldSales({ measures: [m] });
  const yaml = scaffoldCubeYaml(d);
  const r = convergence(d, { form, agent: { ...form }, yaml });
  assert.ok(r.ok, JSON.stringify(r.rows));
  assert.equal(r.member, 'Sales.completed_revenue');
});

test('convergence FAILS when the form and hand-edited YAML disagree on a filter', () => {
  const form: MetricForm = {
    name: 'Completed revenue', aggregation: 'sum', column: 'net_amount', dimensions: [],
    filter: { column: 'status', operator: 'equals', value: 'completed' },
  };
  // The YAML is scaffolded from a DIFFERENT (unfiltered) measure — a real divergence.
  const plain = measureFromForm({ name: 'Completed revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] });
  const yaml = scaffoldCubeYaml(goldSales({ measures: [plain] }));
  const r = convergence(goldSales(), { form, agent: { ...form }, yaml });
  assert.equal(r.ok, false, 'a filter present in the form but absent in the YAML must be caught');
});
