/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, rateLimitReset } from './ratelimit.ts';

test('globalThis pin: create survives a fresh bkts() call', () => {
  // Write a bucket entry via the public API.
  const r = rateLimit('pin-test-key', 10, 60_000);
  assert.equal(r.ok, true);

  // Confirm entry is visible via the globalThis symbol directly.
  const pinned = (globalThis as any)[Symbol.for('soa.ratelimit.buckets')] as Map<string, unknown>;
  assert.ok(pinned instanceof Map, 'globalThis pin is a Map');
  assert.ok(pinned.has('pin-test-key'), 'bucket entry visible via globalThis pin');

  // A subsequent call (fresh bkts()) still sees the same bucket.
  const r2 = rateLimit('pin-test-key', 10, 60_000);
  assert.equal(r2.ok, true);

  rateLimitReset('pin-test-key');
  assert.equal(pinned.has('pin-test-key'), false, 'reset clears via pinned map');
});
