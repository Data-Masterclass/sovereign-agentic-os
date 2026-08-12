/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE task-inference heuristic (content-first, dtype tiebreaker). These pin the cases the owner
 * hit (a continuous `duration_days` double must be regression, not binary_classification) and the
 * content-vs-type precedence (a 0/1 bigint is binary; a 5-distinct int is multiclass).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTaskFromTarget } from './infer-task.ts';

test('continuous double → regression (the duration_days case)', () => {
  assert.equal(inferTaskFromTarget({ type: 'double' }), 'regression');
  assert.equal(inferTaskFromTarget({ type: 'double', distinctCount: 800, isIntegerValued: false }), 'regression');
});

test('a float column with fractional values → regression even when distinct is small', () => {
  // Content beats a small distinct count: fractional values are continuous, not categories.
  assert.equal(inferTaskFromTarget({ type: 'real', distinctCount: 6, isIntegerValued: false }), 'regression');
});

test('boolean type → binary_classification', () => {
  assert.equal(inferTaskFromTarget({ type: 'boolean' }), 'binary_classification');
});

test('distinctCount === 2 → binary_classification (any declared type)', () => {
  assert.equal(inferTaskFromTarget({ type: 'bigint', distinctCount: 2, isIntegerValued: true }), 'binary_classification');
  assert.equal(inferTaskFromTarget({ type: 'varchar', distinctCount: 2 }), 'binary_classification');
  assert.equal(inferTaskFromTarget({ type: 'double', distinctCount: 2, isIntegerValued: true }), 'binary_classification');
});

test('bigint with many distinct values → regression', () => {
  assert.equal(inferTaskFromTarget({ type: 'bigint', distinctCount: 5000, isIntegerValued: true }), 'regression');
});

test('integer with a small integer-valued distinct set → multiclass_classification (categories)', () => {
  assert.equal(inferTaskFromTarget({ type: 'integer', distinctCount: 5, isIntegerValued: true }), 'multiclass_classification');
});

test('integer with unknown distinct count → regression (dtype fallback, not forced categorical)', () => {
  assert.equal(inferTaskFromTarget({ type: 'bigint' }), 'regression');
});

test('varchar with a small distinct set → multiclass_classification', () => {
  assert.equal(inferTaskFromTarget({ type: 'varchar', distinctCount: 8 }), 'multiclass_classification');
  assert.equal(inferTaskFromTarget({ type: 'varchar(40)', distinctCount: 20 }), 'multiclass_classification');
});

test('high-cardinality varchar → undefined (likely an id — do not force)', () => {
  assert.equal(inferTaskFromTarget({ type: 'varchar', distinctCount: 5000 }), undefined);
  assert.equal(inferTaskFromTarget({ type: 'varchar' }), undefined); // unknown distinct on a string
});

test('decimal(10,2) with fractional values → regression (paren-stripping + content)', () => {
  assert.equal(inferTaskFromTarget({ type: 'decimal(10,2)', isIntegerValued: false }), 'regression');
});

test('date / timestamp / unknown types with no content signal → undefined', () => {
  assert.equal(inferTaskFromTarget({ type: 'date' }), undefined);
  assert.equal(inferTaskFromTarget({ type: 'timestamp' }), undefined);
  assert.equal(inferTaskFromTarget({ type: 'varbinary' }), undefined);
});
