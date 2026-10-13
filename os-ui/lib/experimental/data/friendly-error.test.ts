/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyTrinoError } from './friendly-error.ts';

const TYPE_MISMATCH =
  'TrinoUserError(type=USER_ERROR, name=TYPE_MISMATCH, message="line 1:362: Cannot apply operator: varchar * integer", query_id=20260803_120000_00001_abcde)';

test('TYPE_MISMATCH varchar * integer → text/number friendly line, raw preserved', () => {
  const r = friendlyTrinoError(TYPE_MISMATCH);
  assert.match(r.friendly, /mixes text and numbers/);
  assert.match(r.friendly, /varchar/);
  assert.match(r.friendly, /CAST\(col AS double\)/);
  assert.equal(r.raw, TYPE_MISMATCH); // raw untouched for the query_id
});

test('TYPE_MISMATCH picks the text side when it is on the right', () => {
  const r = friendlyTrinoError(
    'TrinoUserError(type=USER_ERROR, name=TYPE_MISMATCH, message="Cannot apply operator: integer + varchar", query_id=q1)',
  );
  assert.match(r.friendly, /text \(varchar\)/);
});

test('TYPE_MISMATCH without a parseable operator still gives a cast hint', () => {
  const r = friendlyTrinoError(
    'TrinoUserError(type=USER_ERROR, name=TYPE_MISMATCH, message="line 1:5: something odd", query_id=q2)',
  );
  assert.match(r.friendly, /Cast the text column/);
  assert.equal(r.raw.includes('q2'), true);
});

test('COLUMN_NOT_FOUND → spelling hint with the column name', () => {
  const r = friendlyTrinoError(
    `TrinoUserError(type=USER_ERROR, name=COLUMN_NOT_FOUND, message="line 1:8: Column 'revenu' cannot be resolved", query_id=q3)`,
  );
  assert.match(r.friendly, /'revenu' doesn't exist/);
  assert.match(r.friendly, /check the spelling/);
});

test('INVALID_CAST_ARGUMENT → text-not-a-number friendly line with the value', () => {
  const r = friendlyTrinoError(
    `TrinoUserError(type=USER_ERROR, name=INVALID_CAST_ARGUMENT, message="Cannot cast 'CUS-2002' to INT", query_id=q6)`,
  );
  assert.match(r.friendly, /'CUS-2002' can't become a int/);
  assert.match(r.friendly, /Keep it as text/);
});

test('SYNTAX_ERROR → invalid-SQL friendly line', () => {
  const r = friendlyTrinoError(
    `TrinoUserError(type=USER_ERROR, name=SYNTAX_ERROR, message="line 1:1: mismatched input '('. Expecting: <expression>", query_id=q4)`,
  );
  assert.match(r.friendly, /isn't valid SQL/);
});

test('fallback: an unknown Trino wrapper strips to the inner message (no query_id noise)', () => {
  const r = friendlyTrinoError(
    'TrinoUserError(type=USER_ERROR, name=GENERIC_INTERNAL_ERROR, message="line 1:1: something unexpected happened", query_id=q5)',
  );
  assert.equal(r.friendly, 'line 1:1: something unexpected happened');
  assert.ok(!r.friendly.includes('query_id'));
  assert.ok(!r.friendly.includes('TrinoUserError'));
  assert.equal(r.raw.includes('query_id=q5'), true);
});

test('non-Trino passthrough: a plain app message is returned unchanged', () => {
  const r = friendlyTrinoError('Could not preview rows');
  assert.equal(r.friendly, 'Could not preview rows');
  assert.equal(r.raw, 'Could not preview rows');
});

test('empty / nullish input is safe', () => {
  assert.equal(friendlyTrinoError('').friendly, '');
  // @ts-expect-error — defensive: exercise the String() coercion path
  assert.equal(friendlyTrinoError(undefined).friendly, '');
});
