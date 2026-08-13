/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * interactive-logic.test — the PURE helpers the 3.5c interactive renderers share: field coercion,
 * HONEST write-result classification (only a live-app write is a real save), and the `by` stamp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceField, classifyWriteResult, actorStamp } from './interactive-logic.ts';
import type { RecordResult } from '@/lib/app-sdk/index.ts';

test('coerceField coerces per type; empty → undefined (omitted)', () => {
  assert.equal(coerceField('text', 'hi'), 'hi');
  assert.equal(coerceField('number', '42'), 42);
  assert.equal(coerceField('number', 'nope'), 'nope'); // non-numeric stays as raw, honestly
  assert.equal(coerceField('boolean', 'true'), true);
  assert.equal(coerceField('boolean', 'false'), false);
  assert.equal(coerceField('date', '2026-08-12'), '2026-08-12');
  assert.equal(coerceField('text', ''), undefined);
  assert.equal(coerceField('number', ''), undefined);
});

test('classifyWriteResult: only a live-app result is a real save', () => {
  const live: RecordResult = { source: 'live-app', added: { id: '1' } };
  const seed: RecordResult = { source: 'demo-seed', note: 'runner not live' };
  const a = classifyWriteResult(live, 'Saved.');
  assert.deepEqual(a, { saved: true, tone: 'success', message: 'Saved.' });
  const b = classifyWriteResult(seed, 'Saved.');
  assert.equal(b.saved, false);
  assert.equal(b.tone, 'info');
  assert.match(b.message, /Not saved for real/);
  assert.match(b.message, /runner not live/);
});

test('actorStamp prefers username, falls back to id then unknown', () => {
  assert.equal(actorStamp({ user: { id: 'u1', username: 'amir' } }), 'amir');
  assert.equal(actorStamp({ user: { id: 'u1' } }), 'u1');
  assert.equal(actorStamp({ user: null }), 'unknown');
  assert.equal(actorStamp(null), 'unknown');
  assert.equal(actorStamp(undefined), 'unknown');
});
