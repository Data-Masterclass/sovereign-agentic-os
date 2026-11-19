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
import { cleanTurns } from '@core/runtime/turns';

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
  assert.match(out[0].content, /^\[5 earlier turns of this conversation were omitted.*\]\nm5$/, 'the oldest kept turn says what was dropped (Track B)');
  assert.equal(out[19].content, 'm24');
});

test('non-array input yields an empty list', () => {
  assert.deepEqual(cleanTurns(undefined), []);
  assert.deepEqual(cleanTurns(null), []);
  assert.deepEqual(cleanTurns('nope'), []);
  assert.deepEqual(cleanTurns({}), []);
});

test('readBoundedTurns (Track B): both cuts are told — dropped turns and a message cut short', async () => {
  const { readBoundedTurns } = await import('@core/runtime/turns');
  const msgs = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: i === 14 ? 'x'.repeat(5_000) : `m${i}` }));
  const out = readBoundedTurns(msgs);
  assert.equal(out.length, 12);
  assert.match(out[0].content, /^\[3 earlier messages were omitted to keep the request short\.\]\nm3$/);
  assert.match(out[11].content, /\[…this message was cut at 4000 of 5000 characters\]$/);
  assert.deepEqual(readBoundedTurns([{ role: 'user', content: 'hi' }]), [{ role: 'user', content: 'hi' }]);
});
