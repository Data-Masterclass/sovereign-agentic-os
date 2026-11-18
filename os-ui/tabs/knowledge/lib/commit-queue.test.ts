/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The workflow editor's commit queue — an edit is never silently dropped
 * USER STORY: As a process owner editing a step I must know that an edit made while the previous
 *             save is still in flight lands too, and that any failure is reported rather than lost.
 * ARCHITECTURE:
 *   - The queue is a pure helper in `lib/` precisely so it can be tested: a test cannot import the
 *     `.tsx` that uses it (ARCHITECTURE.md), so the behaviour lives where a test can reach it.
 *   - Serial by construction, resolves an outcome instead of throwing, and reports every failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommitQueue } from '@tabs/knowledge/lib/commit-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = () => res(); });
  return { promise, resolve };
}

test('a commit enqueued while another is in flight is queued, never dropped', async () => {
  const order: string[] = [];
  const first = deferred();
  const q = createCommitQueue();
  const a = q.enqueue(async () => { order.push('a:start'); await first.promise; order.push('a:end'); });
  const b = q.enqueue(async () => { order.push('b'); });
  const c = q.enqueue(async () => { order.push('c'); });
  assert.equal(q.pending, 3);
  first.resolve();
  assert.deepEqual(await Promise.all([a, b, c]), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c']);
  assert.equal(q.pending, 0);
});

test('a failing commit is reported and does not block the ones behind it', async () => {
  const errors: string[] = [];
  const q = createCommitQueue({ onError: (m) => errors.push(m) });
  const bad = q.enqueue(async () => { throw new Error('409 stale sha'); });
  const good = q.enqueue(async () => { /* must still run */ });
  assert.deepEqual(await bad, { ok: false, error: '409 stale sha' });
  assert.deepEqual(await good, { ok: true });
  assert.deepEqual(errors, ['409 stale sha']);
});

test('busy flips true while work is in flight and false when the queue drains', async () => {
  const busy: boolean[] = [];
  const q = createCommitQueue({ onBusyChange: (b) => busy.push(b) });
  assert.equal(q.busy, false);
  await q.enqueue(async () => {});
  await q.enqueue(async () => {});
  assert.deepEqual(busy, [true, false, true, false]);
  assert.equal(q.busy, false);
});

test('a thrown non-Error still yields a reported message', async () => {
  const errors: string[] = [];
  const q = createCommitQueue({ onError: (m) => errors.push(m) });
  const out = await q.enqueue(async () => { throw 'nope'; });
  assert.equal(out.ok, false);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].length > 0);
});
