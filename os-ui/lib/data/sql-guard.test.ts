/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSingleStatement, MULTI_STATEMENT_MESSAGE } from './sql-guard.ts';

test('GUARD: a plain SELECT is unchanged', () => {
  const r = sanitizeSingleStatement('select 1 from t');
  assert.deepEqual(r, { ok: true, sql: 'select 1 from t' });
});

test('GUARD: a single trailing semicolon is stripped so the statement runs', () => {
  const r = sanitizeSingleStatement('select region, sum(revenue) from t group by region;');
  assert.ok(r.ok);
  assert.equal(r.sql, 'select region, sum(revenue) from t group by region');
});

test('GUARD: trailing whitespace + multiple trailing semicolons collapse to one statement', () => {
  const r = sanitizeSingleStatement('  select 1 from t ;  ; \n');
  assert.ok(r.ok);
  assert.equal(r.sql, 'select 1 from t');
});

test('GUARD: an INTERNAL semicolon (real multi-statement) is rejected with the clear message', () => {
  const r = sanitizeSingleStatement('select 1; drop table t');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, MULTI_STATEMENT_MESSAGE);
});

test('GUARD: multi-statement with a trailing semicolon still rejects (only the last is peeled)', () => {
  const r = sanitizeSingleStatement('select 1; select 2;');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, MULTI_STATEMENT_MESSAGE);
});
