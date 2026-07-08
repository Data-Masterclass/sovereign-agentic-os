/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCheck,
  aggregateBadge,
  verdictFromViolations,
  ruleLabel,
  DqError,
  type CheckResult,
} from './dq.ts';
import type { DataCheck } from './dataset-schema.ts';

const FQN = 'iceberg.sales.gold_orders';
function chk(over: Partial<DataCheck>): DataCheck {
  return { id: 'c1', name: '', description: '', createdBy: 'amir', createdAt: '', ...over };
}

test('not_null compiles to a count of null rows', () => {
  const { sql } = compileCheck(chk({ rule: 'not_null', column: 'order_id' }), FQN);
  assert.equal(sql, `select count(*) as v from ${FQN} where "order_id" is null`);
});

test('not_blank counts null OR whitespace-only strings', () => {
  const { sql } = compileCheck(chk({ rule: 'not_blank', column: 'name' }), FQN);
  assert.match(sql, /"name" is null or trim\(cast\("name" as varchar\)\) = ''/);
});

test('unique counts rows in duplicate (non-null) groups', () => {
  const { sql } = compileCheck(chk({ rule: 'unique', column: 'order_id' }), FQN);
  assert.match(sql, /group by "order_id" having count\(\*\) > 1/);
  assert.match(sql, /coalesce\(sum\(cnt\), 0\) as v/);
});

test('accepted_values counts non-null values outside the allowed set (and escapes literals)', () => {
  const { sql } = compileCheck(chk({ rule: 'accepted_values', column: 'status', values: ['open', "o'brien"] }), FQN);
  assert.match(sql, /"status" is not null and cast\("status" as varchar\) not in \('open', 'o''brien'\)/);
});

test('accepted_values with no values is not executable', () => {
  assert.throws(() => compileCheck(chk({ rule: 'accepted_values', column: 'status', values: [] }), FQN), DqError);
});

test('range counts values outside [min, max]', () => {
  const { sql } = compileCheck(chk({ rule: 'range', column: 'amount', min: 0, max: 1000 }), FQN);
  assert.match(sql, /"amount" is not null and \("amount" < 0 or "amount" > 1000\)/);
});

test('range allows a one-sided bound', () => {
  const { sql } = compileCheck(chk({ rule: 'range', column: 'amount', min: 0 }), FQN);
  assert.match(sql, /\("amount" < 0\)/);
  assert.doesNotMatch(sql, />/);
});

test('range with no bounds / non-finite bound is rejected', () => {
  assert.throws(() => compileCheck(chk({ rule: 'range', column: 'amount' }), FQN), DqError);
  assert.throws(() => compileCheck(chk({ rule: 'range', column: 'amount', min: Infinity }), FQN), DqError);
});

test('a rule needs a column; a free-text intention is not executable', () => {
  assert.throws(() => compileCheck(chk({ rule: 'not_null', column: '' }), FQN), DqError);
  assert.throws(() => compileCheck(chk({ name: 'legacy note' }), FQN), DqError);
});

test('column identifiers are double-quote escaped (no breakout)', () => {
  const { sql } = compileCheck(chk({ rule: 'not_null', column: 'we"ird' }), FQN);
  assert.match(sql, /"we""ird" is null/);
});

test('verdict: 0 violations pass, > 0 fail', () => {
  assert.equal(verdictFromViolations(0), 'pass');
  assert.equal(verdictFromViolations(3), 'fail');
});

test('badge aggregation is honest: fail dominates; no-runs are unknown, never a fake pass', () => {
  const pass: CheckResult = { id: 'a', label: '', status: 'pass', violations: 0 };
  const fail: CheckResult = { id: 'b', label: '', status: 'fail', violations: 2 };
  const notRun: CheckResult = { id: 'c', label: '', status: 'not_run', violations: null, reason: 'not materialized' };
  assert.equal(aggregateBadge([pass, fail]), 'failing');
  assert.equal(aggregateBadge([pass, notRun]), 'passing');
  assert.equal(aggregateBadge([notRun]), 'unknown');
  assert.equal(aggregateBadge([]), 'unknown');
});

test('ruleLabel renders the dbt-style label', () => {
  assert.equal(ruleLabel(chk({ rule: 'not_null', column: 'id' })), 'not_null(id)');
  assert.equal(ruleLabel(chk({ rule: 'accepted_values', column: 's', values: ['a', 'b'] })), 'accepted_values(s, [a, b])');
  assert.equal(ruleLabel(chk({ rule: 'range', column: 'amt', min: 0, max: 9 })), 'range(amt, 0, 9)');
});
