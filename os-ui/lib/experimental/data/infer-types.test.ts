/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferType, inferColumnTypes } from './infer-types.ts';

test('inferType: strict per-column detection from sampled values', () => {
  assert.equal(inferType(['1', '42', '-7']), 'integer');
  assert.equal(inferType(['9999999999']), 'bigint'); // beyond int32
  assert.equal(inferType(['1.5', '2', '-0.25']), 'double'); // mixed ints + decimals
  assert.equal(inferType(['2026-01-31', '2026-02-01']), 'date');
  assert.equal(inferType(['2026-01-31 10:30:00', '2026-01-31T11:00:00']), 'timestamp');
  assert.equal(inferType(['yes', 'no', 'Yes', 'NO']), 'boolean'); // the original yes/no case
  assert.equal(inferType(['true', 'false']), 'boolean');
  // Ambiguity rules + strictness:
  assert.equal(inferType(['0', '1', '1']), 'integer'); // numbers beat boolean
  assert.equal(inferType(['42', 'abc']), null); // ONE mismatch → no suggestion
  assert.equal(inferType(['', '  ']), null); // empty column → no suggestion
  assert.equal(inferType(['12', '', '15']), 'integer'); // blanks (nulls) are ignored
  assert.equal(inferType(['EMEA', 'APAC']), null); // plain text stays text
});

test('inferColumnTypes maps a preview grid to per-column suggestions', () => {
  const columns = ['case_id', 'resolved', 'region', 'opened'];
  const rows = [
    ['1001', 'yes', 'EMEA', '2026-06-01'],
    ['1002', 'no', 'APAC', '2026-06-02'],
  ];
  assert.deepEqual(inferColumnTypes(columns, rows), [
    { column: 'case_id', type: 'integer' },
    { column: 'resolved', type: 'boolean' },
    { column: 'opened', type: 'date' },
  ]);
});
