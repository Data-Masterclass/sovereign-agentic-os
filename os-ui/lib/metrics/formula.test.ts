/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFormulaRefs, compileFormula } from './formula.ts';
import { exploreSpec } from './explorer.ts';
import { previewTrinoSql } from './explorer.ts';
import { formFromMeasure, measureFromForm, sameMeasure } from './model.ts';
import { goldSales } from './fixtures.ts';

test('compileFormula: the Power BI shape — ([a] - [b]) / [c], null-safe division', () => {
  const { sql, refs } = compileFormula('([revenue] - [cost]) / [orders]');
  assert.equal(sql, '1.0 * (({revenue} - {cost}) / NULLIF({orders}, 0))');
  assert.deepEqual(refs.sort(), ['cost', 'orders', 'revenue']);
});

test('compileFormula: precedence and constants survive (SQL * and / bind before + -)', () => {
  const { sql } = compileFormula('[a] + [b] * 100 - [c] / 2');
  assert.equal(sql, '1.0 * ({a} + {b} * 100 - {c} / NULLIF(2, 0))');
});

test('compileFormula: clear errors — unknown char, unclosed ref, empty, trailing junk', () => {
  assert.throws(() => compileFormula('[a] % [b]'), /Unexpected "%"/);
  assert.throws(() => compileFormula('[a / [b]'), /Unclosed metric reference|not a metric name/);
  assert.throws(() => compileFormula('   '), /empty/);
  assert.throws(() => compileFormula('[a] [b]'), /missing operator/);
  assert.throws(() => compileFormula('2 + 2'), /references no metric/);
});

test('assertFormulaRefs: unknown and non-basic references are refused by name', () => {
  const siblings = [{ name: 'revenue', type: 'sum' }, { name: 'aov', type: 'number' }];
  assertFormulaRefs(['revenue'], siblings); // ok
  assert.throws(() => assertFormulaRefs(['margin'], siblings), /no such metric.*\[revenue\]/s);
  assert.throws(() => assertFormulaRefs(['aov'], siblings), /only reference BASIC/);
});

test('a formula metric round-trips and SERVES: form → measure → governed Trino SQL', () => {
  const d = goldSales({
    measures: [
      { name: 'revenue', type: 'sum', sql: 'net_amount' },
      { name: 'orders', type: 'count', sql: '' },
    ],
  });
  const form = { name: 'Rev per Order', aggregation: 'number', column: '', dimensions: [], formula: '[revenue] / [orders]' };
  const measure = measureFromForm(form, d.measures);
  assert.equal(measure.type, 'number');
  assert.equal(measure.formula, '[revenue] / [orders]');

  // Round-trip: the hydrated Edit form re-saves onto the IDENTICAL measure.
  const back = formFromMeasure(measure);
  assert.equal(back.formula, '[revenue] / [orders]');
  assert.ok(sameMeasure(measureFromForm(back, d.measures), measure));

  // Serve: refs expand one level into the basic aggregates, null-safe.
  const withFormula = { ...d, measures: [...d.measures, measure] };
  const sql = previewTrinoSql(withFormula, measure, exploreSpec(withFormula, measure, { dimensions: ['region'] }))!;
  assert.match(sql, /SUM\(CAST\(net_amount AS double\)\)/);
  assert.match(sql, /NULLIF\(\(COUNT\(\*\)\), 0\)/);
  assert.match(sql, /GROUP BY/);
});

test('a formula referencing a missing metric fails at define-time with a naming error', () => {
  const d = goldSales();
  const form = { name: 'Broken', aggregation: 'number', column: '', dimensions: [], formula: '[revenue] / [orders]' };
  assert.throws(() => measureFromForm(form, d.measures), /\[orders\].*no such metric/s);
});
