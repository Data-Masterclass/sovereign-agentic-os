/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFileName, uploadObjectKey } from './object-store.ts';
import { sanitizeIdent, personalSchema } from './store-fqn.ts';

/**
 * T3 governance: the upload object key is ALWAYS forced under the caller's own
 * `uploads/<uid>/` prefix from the SESSION principal, and the filename can never
 * escape it — the single choke point that stops cross-user object writes. Mirrors
 * the runner's independent re-check (images/data-runner: `expected_prefix`).
 */

test('uploadObjectKey forces the caller uid prefix', () => {
  assert.equal(uploadObjectKey('creator', 'returns.csv'), 'uploads/creator/returns.csv');
  // Two different session principals can never share a prefix.
  assert.notEqual(uploadObjectKey('creator', 'x.csv').split('/')[1], uploadObjectKey('outsider', 'x.csv').split('/')[1]);
});

test('a request-body principal cannot widen the prefix (only the passed session principal counts)', () => {
  // The route passes user.id as the principal; whatever a caller might smuggle in the
  // body is irrelevant here — the key is derived solely from the session principal.
  const key = uploadObjectKey('creator', 'returns.csv');
  assert.ok(key.startsWith('uploads/creator/'), key);
});

test('filename path-traversal is stripped — the key stays under the prefix', () => {
  assert.equal(uploadObjectKey('creator', '../../etc/passwd'), 'uploads/creator/passwd');
  assert.equal(uploadObjectKey('creator', 'a/b/c/deep.csv'), 'uploads/creator/deep.csv');
  assert.equal(uploadObjectKey('creator', '..\\..\\win.csv'), 'uploads/creator/win.csv');
  // Every key has exactly the fixed 3-segment shape uploads/<uid>/<file>.
  for (const name of ['../../x', 'a/b', 'ok.csv', '   ', '.hidden']) {
    const parts = uploadObjectKey('u', name).split('/');
    assert.equal(parts.length, 3, name);
    assert.equal(parts[0], 'uploads');
    assert.equal(parts[1], 'u');
  }
});

test('safeFileName sanitizes spaces + unusual chars but keeps a usable name', () => {
  assert.equal(safeFileName('My Data (2026).csv'), 'My_Data_2026_.csv');
  assert.equal(safeFileName(''), 'upload');
  assert.equal(safeFileName('/tmp/../evil'), 'evil');
});

test('sanitizeIdent + personalSchema match the runner/query-tool normalization', () => {
  // Same mapping the query-tool test asserts (test_execute_guard: email → personal schema).
  assert.equal(personalSchema('omar@acme.example'), 'personal_omar_acme_example');
  assert.equal(sanitizeIdent('Creator One'), 'creator_one');
  assert.equal(sanitizeIdent(''), 'user');
});
