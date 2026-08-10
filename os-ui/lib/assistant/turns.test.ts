/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * cleanTurns — the shared turn-cleaning filter three streaming routes hand-rolled
 * identically (chat / agents-run / software-team). Pins the exact behaviour those
 * copies had, so the hoist stays behaviour-preserving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTurns } from './turns.ts';

test('drops non-user/assistant, blank and non-string messages; trims content', () => {
  const out = cleanTurns([
    { role: 'user', content: '  hi  ' },
    { role: 'system', content: 'nope' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 42 },
    null,
    { role: 'assistant', content: ' there ' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'there' },
  ]);
});

test('keeps only the last 20 turns', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
  const out = cleanTurns(many);
  assert.equal(out.length, 20);
  assert.equal(out[0].content, 'm5');
  assert.equal(out[19].content, 'm24');
});

test('non-array input yields an empty list', () => {
  assert.deepEqual(cleanTurns(undefined), []);
  assert.deepEqual(cleanTurns(null), []);
  assert.deepEqual(cleanTurns('nope'), []);
  assert.deepEqual(cleanTurns({}), []);
});
