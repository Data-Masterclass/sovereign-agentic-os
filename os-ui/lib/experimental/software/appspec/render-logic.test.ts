/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * render-logic.test — the pure core every declarative app inherits. Column mapping BY NAME
 * (incl. reordered + missing), each format, and the generic filter/search/sort/paginate
 * pipeline (incl. numeric sort over a currency column). No DOM, no store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveColumns, formatCell, applyView, type ResolvedColumn } from './render-logic.ts';
import type { TableColumn } from './schema.ts';

// -------------------------------------------------------------- resolveColumns ----------

test('resolveColumns maps each spec column to its live index BY NAME', () => {
  const live = ['order_id', 'amount', 'status'];
  const spec: TableColumn[] = [
    { field: 'status', label: 'State' },
    { field: 'amount', format: 'currency-eur' },
  ];
  const r = resolveColumns(live, spec);
  assert.deepEqual(r, [
    { field: 'status', label: 'State', format: 'text', index: 2 },
    { field: 'amount', label: 'amount', format: 'currency-eur', index: 1 },
  ]);
});

test('resolveColumns is robust to REORDERED live columns (matches by name, not position)', () => {
  const live = ['amount', 'status', 'order_id']; // reordered vs spec
  const spec: TableColumn[] = [{ field: 'order_id' }, { field: 'status' }];
  const r = resolveColumns(live, spec);
  assert.equal(r[0].index, 2); // order_id is now last
  assert.equal(r[1].index, 1);
});

test('resolveColumns yields index -1 for a column the live result lacks', () => {
  const r = resolveColumns(['a', 'b'], [{ field: 'c' }]);
  assert.equal(r[0].index, -1);
  assert.equal(r[0].label, 'c'); // label defaults to field
});

// ------------------------------------------------------------------- formatCell ---------

test('formatCell: text and badge pass through untouched', () => {
  assert.equal(formatCell('hello', 'text'), 'hello');
  assert.equal(formatCell('ACTIVE', 'badge'), 'ACTIVE');
});

test('formatCell: number groups; non-numeric falls back to raw', () => {
  assert.equal(formatCell('1234567', 'number'), '1.234.567'); // de-DE grouping
  assert.equal(formatCell('n/a', 'number'), 'n/a');
  assert.equal(formatCell('', 'number'), '');
});

test('formatCell: currency-eur formats EUR; non-numeric falls back', () => {
  assert.equal(formatCell('1999.5', 'currency-eur'), '1.999,50 €');
  assert.equal(formatCell('free', 'currency-eur'), 'free');
});

test('formatCell: date normalises to ISO yyyy-mm-dd; unparseable falls back', () => {
  assert.equal(formatCell('2026-08-12T09:30:00Z', 'date'), '2026-08-12');
  assert.equal(formatCell('not-a-date', 'date'), 'not-a-date');
});

// -------------------------------------------------------------------- applyView ---------

const COLS = ['id', 'name', 'price', 'city'];
function resolved(): ResolvedColumn[] {
  return resolveColumns(COLS, [
    { field: 'id' },
    { field: 'name', format: 'text' },
    { field: 'price', format: 'currency-eur' },
    { field: 'city', format: 'text' },
  ]);
}
function grid(): string[][] {
  return [
    ['1', 'Widget', '19.99', 'Berlin'],
    ['2', 'Gadget', '199.90', 'Munich'],
    ['3', 'Gizmo', '5.00', 'Berlin'],
    ['4', 'Doohickey', '49.50', 'Hamburg'],
  ];
}

test('applyView: free-text search matches across columns (case-insensitive)', () => {
  const { rows, total } = applyView(grid(), resolved(), { search: 'berlin' });
  assert.equal(total, 2);
  assert.deepEqual(rows.map((r) => r[0]).sort(), ['1', '3']);
});

test('applyView: select filter matches exact value', () => {
  const { rows, total } = applyView(grid(), resolved(), { filters: { city: { control: 'select', value: 'Munich' } } });
  assert.equal(total, 1);
  assert.equal(rows[0][1], 'Gadget');
});

test('applyView: range filter over a currency column is numeric-aware', () => {
  const { rows, total } = applyView(grid(), resolved(), { filters: { price: { control: 'range', min: 10, max: 100 } } });
  assert.equal(total, 2);
  assert.deepEqual(rows.map((r) => r[1]).sort(), ['Doohickey', 'Widget']);
});

test('applyView: an INVERTED range (min>max) is normalised, not silently empty', () => {
  // A user who types min=100, max=10 means the [10,100] band — a swapped range must not
  // reject every row (the "broken filter" bug). Same result as the ordered band above.
  const swapped = applyView(grid(), resolved(), { filters: { price: { control: 'range', min: 100, max: 10 } } });
  assert.equal(swapped.total, 2);
  assert.deepEqual(swapped.rows.map((r) => r[1]).sort(), ['Doohickey', 'Widget']);
});

test('applyView: a degenerate range (min==max) matches exactly that value', () => {
  // 19.99 is the "Widget" price in the fixture; min==max must match it (no divide-by-zero).
  const eq = applyView(grid(), resolved(), { filters: { price: { control: 'range', min: 19.99, max: 19.99 } } });
  assert.equal(eq.total, 1);
  assert.equal(eq.rows[0][1], 'Widget');
});

test('applyView: sort on a currency column is NUMERIC, not lexical', () => {
  const { rows } = applyView(grid(), resolved(), { sort: { field: 'price', dir: 'asc' } });
  // lexical would put "19.99" before "5.00"; numeric puts 5.00 first.
  assert.deepEqual(rows.map((r) => r[2]), ['5.00', '19.99', '49.50', '199.90']);
});

test('applyView: descending numeric sort reverses the order', () => {
  const { rows } = applyView(grid(), resolved(), { sort: { field: 'price', dir: 'desc' } });
  assert.deepEqual(rows.map((r) => r[2]), ['199.90', '49.50', '19.99', '5.00']);
});

test('applyView: text sort is lexical', () => {
  const { rows } = applyView(grid(), resolved(), { sort: { field: 'name', dir: 'asc' } });
  assert.deepEqual(rows.map((r) => r[1]), ['Doohickey', 'Gadget', 'Gizmo', 'Widget']);
});

test('applyView: pagination slices the sorted set and reports the pre-page total', () => {
  const { rows, total } = applyView(grid(), resolved(), { sort: { field: 'id', dir: 'asc' }, page: 1, pageSize: 2 });
  assert.equal(total, 4);
  assert.deepEqual(rows.map((r) => r[0]), ['3', '4']); // second page of 2
});

test('applyView: search + filter + sort + paginate compose correctly', () => {
  const { rows, total } = applyView(grid(), resolved(), {
    filters: { city: { control: 'select', value: 'Berlin' } },
    sort: { field: 'price', dir: 'desc' },
    page: 0,
    pageSize: 1,
  });
  assert.equal(total, 2); // Berlin rows: Widget(19.99), Gizmo(5.00)
  assert.deepEqual(rows.map((r) => r[1]), ['Widget']); // highest price first, page size 1
});

test('applyView: a filter on an unmapped field is a no-op (fail-soft)', () => {
  const { total } = applyView(grid(), resolved(), { filters: { ghost: { control: 'select', value: 'x' } } });
  assert.equal(total, 4);
});

test('applyView: an absent column index reads as empty (no crash)', () => {
  const res = resolveColumns(['id'], [{ field: 'id' }, { field: 'missing' }]);
  const { rows, total } = applyView([['1'], ['2']], res, { search: '2' });
  assert.equal(total, 1);
  assert.equal(rows[0][0], '2');
});
