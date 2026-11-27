/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The builder's live formula validation renders `FormulaError.key/args` through the `metrics` catalog. These
 * tests prove the English a user reads is byte-identical to the error's English `message`, and that every
 * key exists in all seven languages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFormulaRefs, compileFormula, FormulaError } from '@tabs/metrics/lib/formula';
import { textFor, CATALOG_LOCALES } from '@core/testing/catalog-text';

const text = textFor('metrics');

function errorOf(fn: () => unknown): FormulaError {
  try { fn(); } catch (e) { if (e instanceof FormulaError) return e; throw e; }
  throw new Error('expected a FormulaError');
}

const CASES: [string, () => unknown][] = [
  ['unclosedRef', () => compileFormula('[a / 2')],
  ['notMetricName', () => compileFormula('[Net Amount] / 2')],
  ['unexpectedChar', () => compileFormula('[a] % [b]')],
  ['empty', () => compileFormula('   ')],
  ['endsUnexpectedly', () => compileFormula('[a] +')],
  ['unclosedParen', () => compileFormula('([a] + [b]')],
  ['unexpectedOp', () => compileFormula('[a] * )')],
  ['trailing (op)', () => compileFormula('[a] )')],
  ['trailing (ref)', () => compileFormula('[a] [b]')],
  ['trailing (num)', () => compileFormula('([a]) 2')],
  ['noRef', () => compileFormula('2 + 2')],
  ['unknownRef (with siblings)', () => assertFormulaRefs(['margin'], [{ name: 'revenue', type: 'sum' }, { name: 'cost', type: 'sum' }])],
  ['unknownRef (none yet)', () => assertFormulaRefs(['margin'], [])],
  ['notBasic', () => assertFormulaRefs(['aov'], [{ name: 'aov', type: 'number' }])],
];

for (const [name, fn] of CASES) {
  test(`FormulaError ${name}: the English catalog text is identical to the English message`, () => {
    const e = errorOf(fn);
    assert.equal(text({ key: `formula.errors.${e.key}`, args: e.args }), e.message);
  });
}

test('every FormulaError key renders in all seven languages', () => {
  for (const [, fn] of CASES) {
    const e = errorOf(fn);
    for (const locale of CATALOG_LOCALES) {
      const out = text({ key: `formula.errors.${e.key}`, args: e.args }, locale);
      assert.ok(out.trim().length > 0, `${locale}: formula.errors.${e.key}`);
    }
  }
});
