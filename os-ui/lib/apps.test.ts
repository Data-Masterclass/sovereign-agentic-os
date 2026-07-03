/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Cross-instance pinning test for lib/apps.ts.
 * Verifies that appCacheState() is stored on globalThis so the same Map is returned
 * from any module instance in the same process (Next.js API-route bundles share state).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing apps.ts so every OpenSearch ping fails fast
// and getCache() initialises an empty in-process Map (offline mode).
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { listAppsForUser, __resetAppsCache } = await import('./apps.ts');

const APP_KEY = Symbol.for('soa.apps.cache');
const user = { id: 'u1', name: 'U1', domains: ['sales'], role: 'admin' as const };

test('globalThis: soa.apps.cache — pinned Map survives across module calls', async () => {
  __resetAppsCache();
  // First call: warms the cache into globalThis.
  await listAppsForUser(user);
  const g = (globalThis as any)[APP_KEY];
  assert.ok(g, 'globalThis key is set after first call');
  assert.ok(g.cache instanceof Map, 'cache is a Map on globalThis');
  const ref = g.cache;
  // Second call: must return the same cached Map, not a fresh instance.
  await listAppsForUser(user);
  assert.strictEqual(
    (globalThis as any)[APP_KEY].cache,
    ref,
    'pinned: same Map instance returned on every call',
  );
});
