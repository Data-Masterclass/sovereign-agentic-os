/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       prefs
 * FEATURE:    Tests for the by-id preference reader — no cached "empty" after a failed read, backoff, TTL, no cap
 * USER STORY: As a user my saved preferences come back by themselves once OpenSearch is ready, without a restart,
 *             however many users the tenant has.
 * ARCHITECTURE:
 *   - `perUserDoc` with a scripted `read` and an injected clock — no OpenSearch, deterministic timing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MirrorRead } from '@core/infra/os-mirror';
import { perUserDoc } from '@core/prefs/per-user-doc';

function harness(opts: { ttlMs?: number } = {}) {
  let t = 1_000_000;
  const store = new Map<string, unknown>();
  let down = false;
  const reads: string[] = [];
  const read = async (id: string): Promise<MirrorRead> => {
    reads.push(id);
    if (down) return { state: 'unreachable' };
    return store.has(id) ? { state: 'found', doc: store.get(id) } : { state: 'absent' };
  };
  const docs = perUserDoc<string>({
    read,
    docId: (k) => `p-${k}`,
    parse: (d) => ((d as { v?: unknown })?.v as string) ?? null,
    ttlMs: opts.ttlMs ?? 30_000,
    baseBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    now: () => t,
  });
  return {
    docs, store, reads,
    setDown: (v: boolean) => { down = v; },
    advance: (ms: number) => { t += ms; },
  };
}

test('a read while the store is NOT ready is not cached: undefined now, the saved value once it heals', async () => {
  const h = harness();
  h.store.set('p-ada', { v: 'de' });
  h.setDown(true);
  assert.equal(await h.docs.get('ada'), undefined, 'unknown, so the caller uses its default for now');
  h.setDown(false);
  assert.equal(await h.docs.get('ada'), undefined, 'still inside the 1 s backoff: the dead store is not asked again');
  assert.equal(h.reads.length, 1);
  h.advance(1_000);
  assert.equal(await h.docs.get('ada'), 'de', 'after the backoff the real value is read — no restart needed');
});

test('the backoff doubles per failure and is capped', async () => {
  const h = harness();
  h.setDown(true);
  const tries: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const before = h.reads.length;
    await h.docs.get('ada');
    tries.push(h.reads.length - before);
    h.advance(999);
    await h.docs.get('ada');
    assert.equal(h.reads.length, before + 1, `no re-read inside the backoff window (attempt ${i + 1})`);
    h.advance(2 ** i * 1_000); // wait out (more than) the current window
  }
  assert.deepEqual(tries, [1, 1, 1, 1, 1, 1]);
  // capped: after many failures the window is maxBackoffMs (8 s), not 2^n s
  h.advance(8_000);
  const before = h.reads.length;
  await h.docs.get('ada');
  assert.equal(h.reads.length, before + 1);
});

test('"never saved" (404) is an answer and is cached; a found value is reused for the TTL, then re-read', async () => {
  const h = harness({ ttlMs: 30_000 });
  assert.equal(await h.docs.get('ben'), null);
  assert.equal(await h.docs.get('ben'), null);
  assert.equal(h.reads.length, 1);
  h.store.set('p-ben', { v: 'fr' }); // another pod saved meanwhile
  h.advance(29_999);
  assert.equal(await h.docs.get('ben'), null, 'within the TTL');
  h.advance(1);
  assert.equal(await h.docs.get('ben'), 'fr', 'after the TTL the newer value is seen');
});

test('an expired value is still served while the store is down; a local write is authoritative at once', async () => {
  const h = harness({ ttlMs: 1_000 });
  h.store.set('p-cy', { v: 'pl' });
  assert.equal(await h.docs.get('cy'), 'pl');
  h.advance(2_000);
  h.setDown(true);
  assert.equal(await h.docs.get('cy'), 'pl', 'last known value, not a default');
  h.docs.remember('cy', 'cs');
  assert.equal(await h.docs.get('cy'), 'cs');
});

test('concurrent reads of one key share one request; there is no record cap (each key is its own read)', async () => {
  const h = harness();
  for (let i = 0; i < 5000; i += 1) h.store.set(`p-u${i}`, { v: i % 2 ? 'de' : 'it' });
  const [a, b, c] = await Promise.all([h.docs.get('u4999'), h.docs.get('u4999'), h.docs.get('u4999')]);
  assert.deepEqual([a, b, c], ['de', 'de', 'de']);
  assert.equal(h.reads.length, 1);
  assert.equal(await h.docs.get('u0'), 'it');
});
