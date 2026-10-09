/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * interactive-logic.test — the PURE helpers the 3.5c interactive renderers share: field coercion,
 * HONEST write-result classification (only a live-app write is a real save), and the `by` stamp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceField, classifyWriteResult, actorStamp, isRealSave } from './interactive-logic.ts';
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

test('isRealSave: durable OS store AND live app pod are real; demo-seed is not', () => {
  // Regression: the default static-SPA template persists to the durable OS app-records store,
  // which labels `os-records-store` — NOT `live-app`. It must count as a real save, else an
  // in-app "add record" that DID persist wrongly reports "Not saved for real (demo-seed)".
  assert.equal(isRealSave('os-records-store'), true);
  assert.equal(isRealSave('live-app'), true);
  assert.equal(isRealSave('demo-seed'), false);
  assert.equal(isRealSave(undefined), false);
});

test('classifyWriteResult: durable OS-store and live-app are real saves; demo-seed is not', () => {
  const store: RecordResult = { source: 'os-records-store', added: { id: '1' } };
  const live: RecordResult = { source: 'live-app', added: { id: '1' } };
  const seed: RecordResult = { source: 'demo-seed', note: 'runner not live' };
  assert.deepEqual(classifyWriteResult(store, 'Saved.'), { saved: true, tone: 'success', message: 'Saved.' });
  assert.deepEqual(classifyWriteResult(live, 'Saved.'), { saved: true, tone: 'success', message: 'Saved.' });
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
