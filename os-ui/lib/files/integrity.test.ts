/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncationError } from './integrity.ts';

test('whole body (received === declared) → no error', () => {
  assert.equal(truncationError(1000, '1000'), null);
});

test('short read (truncated upload) → a clear, retryable error', () => {
  const err = truncationError(10_000_000, '50000000');
  assert.equal(err, 'upload incomplete — received 10000000 of 50000000 bytes; please retry');
});

test('no Content-Length declared → nothing to compare, no error', () => {
  assert.equal(truncationError(1234, null), null);
  assert.equal(truncationError(1234, ''), null);
  assert.equal(truncationError(1234, 'not-a-number'), null);
});

test('declared zero/negative → treated as absent (no false reject)', () => {
  assert.equal(truncationError(1234, '0'), null);
  assert.equal(truncationError(1234, '-5'), null);
});

test('over-read (received > declared) is still flagged as a mismatch', () => {
  const err = truncationError(2000, '1000');
  assert.equal(err, 'upload incomplete — received 2000 of 1000 bytes; please retry');
});
