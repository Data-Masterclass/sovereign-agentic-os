/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveChart,
  isNumericColumn,
  isNumericCell,
  parseNumber,
  isDateLikeColumn,
  MAX_CHART_ROWS,
} from './ask-chart.ts';

// --------------------------------------------------- honest numeric detection --

test('isNumericCell: only finite numbers of non-empty cells', () => {
  assert.equal(isNumericCell('42'), true);
  assert.equal(isNumericCell('-3.14'), true);
  assert.equal(isNumericCell('  7 '), true);
  assert.equal(isNumericCell(''), false); // blank is not a number
  assert.equal(isNumericCell('  '), false);
  assert.equal(isNumericCell('N/A'), false);
  assert.equal(isNumericCell('12abc'), false);
  assert.equal(isNumericCell('NaN'), false);
});

test('parseNumber: blank/non-numeric → null (a gap), never 0', () => {
  assert.equal(parseNumber('10'), 10);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('  '), null);
  assert.equal(parseNumber('oops'), null);
});

test('isNumericColumn: all non-empty cells numeric → numeric; blanks skipped', () => {
  const rows = [['a', '1'], ['b', ''], ['c', '3']];
  assert.equal(isNumericColumn(rows, 1), true); // blank in the middle is skipped, not fatal
  assert.equal(isNumericColumn(rows, 0), false); // text column
});

test('isNumericColumn: ONE non-numeric cell makes the whole column categorical', () => {
  // The honesty rule: a stray word must NOT be coerced to a number to keep the column numeric.
  const rows = [['jan', '1'], ['feb', 'pending'], ['mar', '3']];
  assert.equal(isNumericColumn(rows, 1), false);
});

test('isNumericColumn: an all-blank column is not numeric (nothing to measure)', () => {
  const rows = [['a', ''], ['b', ''], ['c', '']];
  assert.equal(isNumericColumn(rows, 1), false);
});

test('isDateLikeColumn: ISO dates / year-month / year, but not arbitrary text', () => {
  assert.equal(isDateLikeColumn([['2026-01-01'], ['2026-02-01']], 0), true);
  assert.equal(isDateLikeColumn([['2026-01'], ['2026-02']], 0), true);
  assert.equal(isDateLikeColumn([['2024'], ['2025']], 0), true);
  assert.equal(isDateLikeColumn([['jan'], ['feb']], 0), false);
  assert.equal(isDateLikeColumn([['DE'], ['FR']], 0), false);
});

// --------------------------------------------------------- deriveChart shapes --

test('date column + numeric column → LINE default', () => {
  const columns = ['month', 'revenue'];
  const rows = [['2026-01', '100'], ['2026-02', '150'], ['2026-03', '130']];
  const hint = deriveChart(columns, rows);
  assert.ok(hint);
  assert.equal(hint!.defaultType, 'line');
  assert.equal(hint!.dimension, 0);
  assert.deepEqual(hint!.measures, [1]);
  // No pie for a time series.
  assert.equal(hint!.allowedTypes.includes('pie'), false);
  assert.equal(hint!.allowedTypes.includes('table'), true);
});

test('categorical column + one numeric column (low cardinality) → BAR default, pie offered', () => {
  const columns = ['region', 'revenue'];
  const rows = [['DE', '100'], ['FR', '80'], ['ES', '60']];
  const hint = deriveChart(columns, rows);
  assert.ok(hint);
  assert.equal(hint!.defaultType, 'bar');
  assert.equal(hint!.dimension, 0);
  assert.deepEqual(hint!.measures, [1]);
  assert.equal(hint!.allowedTypes.includes('pie'), true);
});

test('categorical column + MULTIPLE numeric columns → grouped bar, NO pie', () => {
  const columns = ['region', 'revenue', 'orders'];
  const rows = [['DE', '100', '5'], ['FR', '80', '4']];
  const hint = deriveChart(columns, rows);
  assert.ok(hint);
  assert.equal(hint!.defaultType, 'bar');
  assert.deepEqual(hint!.measures, [1, 2]);
  assert.equal(hint!.allowedTypes.includes('pie'), false); // pie can't show 2 measures honestly
});

test('all-text result → NOT chartable (table only)', () => {
  const columns = ['name', 'status'];
  const rows = [['alpha', 'ready'], ['beta', 'pending']];
  assert.equal(deriveChart(columns, rows), null);
});

test('mixed-numeric column stays categorical → dimension picks it, but no measure → not chartable', () => {
  // Column 1 has a stray word, so it is categorical; nothing numeric remains → table only.
  const columns = ['region', 'revenue'];
  const rows = [['DE', '100'], ['FR', 'pending'], ['ES', '60']];
  assert.equal(deriveChart(columns, rows), null);
});

test('single row → NOT chartable (need ≥2 rows)', () => {
  assert.equal(deriveChart(['region', 'revenue'], [['DE', '100']]), null);
});

test('single column → NOT chartable', () => {
  assert.equal(deriveChart(['region'], [['DE'], ['FR']]), null);
});

test('all-numeric grid (no category axis) → NOT chartable', () => {
  const columns = ['a', 'b'];
  const rows = [['1', '2'], ['3', '4']];
  assert.equal(deriveChart(columns, rows), null);
});

test('too many categories for a pie → bar default, pie NOT offered', () => {
  const columns = ['sku', 'units'];
  const rows = Array.from({ length: 20 }, (_, i) => [`sku-${i}`, String(i + 1)]);
  const hint = deriveChart(columns, rows);
  assert.ok(hint);
  assert.equal(hint!.defaultType, 'bar');
  assert.equal(hint!.allowedTypes.includes('pie'), false); // 20 > pie cap
});

test('truncation: >MAX rows sets plottedRows < totalRows', () => {
  const columns = ['month', 'revenue'];
  const total = MAX_CHART_ROWS + 25;
  const rows = Array.from({ length: total }, (_, i) => {
    const mm = String((i % 12) + 1).padStart(2, '0');
    return [`2026-${mm}`, String(i)];
  });
  const hint = deriveChart(columns, rows);
  assert.ok(hint);
  assert.equal(hint!.totalRows, total);
  assert.equal(hint!.plottedRows, MAX_CHART_ROWS);
  assert.ok(hint!.plottedRows < hint!.totalRows); // the caller labels this "first N of M"
});

test('no truncation when the result fits: plottedRows === totalRows', () => {
  const columns = ['region', 'revenue'];
  const rows = [['DE', '100'], ['FR', '80']];
  const hint = deriveChart(columns, rows);
  assert.ok(hint);
  assert.equal(hint!.plottedRows, hint!.totalRows);
  assert.equal(hint!.plottedRows, 2);
});
