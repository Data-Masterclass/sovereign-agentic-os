/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFixExpr, validateSqlType, MAX_FIX_EXPR_LENGTH } from './dq-fix-guard.ts';

const COLS = ['email', 'qty', 'region', 'order_id'];

function ok(expr: string, cols = COLS): string {
  const r = validateFixExpr(expr, cols);
  assert.equal(r.ok, true, `expected ok, got: ${r.ok ? '' : r.reason}`);
  return r.ok ? r.expr : '';
}
function rejected(expr: string, cols = COLS): string {
  const r = validateFixExpr(expr, cols);
  assert.equal(r.ok, false, `expected rejection for: ${expr}`);
  return r.ok ? '' : r.reason;
}

test('fix guard: accepts a plain column transform', () => {
  assert.equal(ok('trim(lower(email))'), 'trim(lower(email))');
});

test('fix guard: accepts quoted identifiers, numbers and string literals', () => {
  ok('coalesce("qty", 0)');
  ok("replace(region, 'EMEA', 'EU')");
  ok("case when region is null then 'unknown' else upper(region) end");
  ok("cast(qty as decimal(10,2))");
});

test('fix guard: strips a single trailing semicolon but rejects stacked statements', () => {
  assert.equal(ok('trim(email);'), 'trim(email)');
  rejected("trim(email); drop table iceberg.sales.orders");
});

test('fix guard: rejects statement smuggling and DDL verbs anywhere', () => {
  assert.match(rejected('(1) when matched then delete'), /'delete'/);
  rejected('1) when matched then delete'); // unbalanced-paren smuggle dies either way
  rejected('drop table x');
  rejected('update email');
  rejected("merge into t");
});

test('fix guard: rejects sub-SELECT smuggling', () => {
  assert.match(rejected('(select secret from other_table)'), /'select'/);
  rejected('coalesce(email, (select max(email) from t))');
});

test('fix guard: rejects SQL comments', () => {
  rejected("trim(email) -- sneak");
  rejected('trim(email) /* sneak */');
});

test('fix guard: rejects unknown identifiers (hidden columns, unvetted functions)', () => {
  assert.match(rejected('trim(secret_col)'), /unknown identifier 'secret_col'/);
  assert.match(rejected('my_evil_udf(email)'), /unknown identifier/);
  assert.match(rejected('coalesce("hidden", email)'), /unknown column "hidden"/);
});

test('fix guard: keywords inside string literals are NOT tripped', () => {
  ok("replace(region, 'select', 'chosen')");
});

test('fix guard: rejects unbalanced parentheses and quotes', () => {
  rejected('trim((email)');
  rejected('trim(email))');
  rejected("concat(email, 'x)");
  rejected('coalesce("qty, 0)');
});

test('fix guard: rejects empty and over-long expressions', () => {
  rejected('');
  rejected('   ');
  rejected(`concat(${Array(200).fill("'x'").join(', ')})`.padEnd(MAX_FIX_EXPR_LENGTH + 10, ' '));
});

test('fix guard: validateSqlType accepts DESCRIBE shapes, rejects smuggling', () => {
  assert.equal(validateSqlType('varchar'), true);
  assert.equal(validateSqlType('varchar(20)'), true);
  assert.equal(validateSqlType('decimal(10,2)'), true);
  assert.equal(validateSqlType('timestamp(6) with time zone'), true);
  assert.equal(validateSqlType(''), false);
  assert.equal(validateSqlType("varchar); drop table x"), false);
  assert.equal(validateSqlType("varchar'"), false);
});
