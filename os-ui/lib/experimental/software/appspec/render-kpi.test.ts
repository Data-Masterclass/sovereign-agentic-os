/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * render-kpi.test — the pure KPI reducers behind the `kpi-overview` cards + `landing` KPI block.
 * Pins: a metric scalar reads the first cell honestly; a dataset aggregate counts/sums/avgs over a
 * NAMED numeric field, ignoring non-numeric/blank cells (never coercing them to 0); and formatKpi
 * is compact + locale-stable. No DOM, no fetch — total functions over the governed grid shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResult } from '@/lib/app-sdk/index.ts';
import { aggregateDataset, formatKpi, metricScalar } from './render-kpi.ts';

function grid(columns: string[], rows: string[][]): QueryResult {
  return { columns, rows, rowCount: rows.length };
}

test('metricScalar reads the first cell; null on an empty/blank result', () => {
  assert.equal(metricScalar(grid(['Orders.revenue'], [['1234']])), 1234);
  assert.equal(metricScalar(grid(['x'], [])), null);
  assert.equal(metricScalar(grid(['x'], [['']])), null);
  assert.equal(metricScalar(grid(['x'], [['not-a-number']])), null);
});

test('aggregateDataset count = row count (no field needed)', () => {
  const g = grid(['a', 'b'], [['1', 'x'], ['2', 'y'], ['3', 'z']]);
  assert.equal(aggregateDataset(g, 'count'), 3);
});

test('aggregateDataset sum/avg over a named field ignore non-numeric + blank cells', () => {
  const g = grid(['amount', 'label'], [['10', 'a'], ['', 'b'], ['20', 'c'], ['n/a', 'd'], ['30', 'e']]);
  assert.equal(aggregateDataset(g, 'sum', 'amount'), 60); // 10+20+30
  assert.equal(aggregateDataset(g, 'avg', 'amount'), 20); // 60 / 3 numeric cells (not /5)
});

test('aggregateDataset returns null for sum/avg with no field, unknown field, or no numeric cells', () => {
  const g = grid(['amount'], [['x'], ['']]);
  assert.equal(aggregateDataset(g, 'sum'), null); // no field
  assert.equal(aggregateDataset(g, 'sum', 'ghost'), null); // unknown column
  assert.equal(aggregateDataset(g, 'avg', 'amount'), null); // no numeric cells
});

test('formatKpi is compact + honest for null', () => {
  assert.equal(formatKpi(null), '—');
  assert.equal(formatKpi(812), '812');
  assert.equal(formatKpi(34500), '34.5k');
  assert.equal(formatKpi(1_200_000), '1.2M');
  assert.equal(formatKpi(3_400_000_000), '3.4B');
  assert.equal(formatKpi(12.5), '12.50');
});
