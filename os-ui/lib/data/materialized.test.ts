/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNotMaterialized, notMaterializedReason } from './materialized.ts';

test('isNotMaterialized recognises the Trino "table not built yet" signatures', () => {
  assert.equal(
    isNotMaterialized(
      new Error('TrinoUserError TABLE_NOT_FOUND: iceberg.sales.bronze_northpeak_cac_cos_weekly does not exist'),
    ),
    true,
  );
  assert.equal(isNotMaterialized(new Error("Schema 'sales' does not exist")), true);
  assert.equal(isNotMaterialized(new Error('SCHEMA_NOT_FOUND')), true);
  assert.equal(isNotMaterialized(new Error('NoSuchBucket: the specified bucket does not exist')), true);
  // Works on a bare string too (some callers throw strings / stringify first).
  assert.equal(isNotMaterialized('iceberg.x.y does not exist'), true);
});

test('isNotMaterialized does NOT swallow a genuinely unreachable engine', () => {
  assert.equal(isNotMaterialized(new Error('Could not reach query-tool')), false);
  assert.equal(isNotMaterialized(new Error('query-tool 502')), false);
  assert.equal(isNotMaterialized(null), false);
  assert.equal(isNotMaterialized(undefined), false);
});

test('notMaterializedReason is calm, honest and names the subject', () => {
  const r = notMaterializedReason('This bronze version');
  assert.match(r, /This bronze version/);
  assert.match(r, /materialized yet/i);
  assert.match(r, /build/i);
});
