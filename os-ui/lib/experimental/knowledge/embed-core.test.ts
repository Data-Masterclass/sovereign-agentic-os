/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashEmbed, cosine } from './embed-core.ts';

test('hashEmbed is deterministic for the same text', () => {
  assert.deepEqual(hashEmbed('bank submission portal'), hashEmbed('bank submission portal'));
});

test('hashEmbed produces the configured dimension (default 384)', () => {
  assert.equal(hashEmbed('x').length, 384);
  assert.equal(hashEmbed('x', 128).length, 128);
});

test('hashEmbed is L2-normalized (self-cosine ≈ 1)', () => {
  const v = hashEmbed('error rate below threshold');
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
});

test('cosine ranks a related query above an unrelated one', () => {
  const doc = hashEmbed('the bank portal truncates long notes on friday submissions');
  const related = cosine(doc, hashEmbed('bank portal friday submission notes'));
  const unrelated = cosine(doc, hashEmbed('photosynthesis chlorophyll sunlight'));
  assert.ok(related > unrelated, `related ${related} should beat unrelated ${unrelated}`);
});

test('empty text yields a zero-ish vector (norm guard, no NaN)', () => {
  const v = hashEmbed('');
  assert.ok(v.every((x) => Number.isFinite(x)));
});
