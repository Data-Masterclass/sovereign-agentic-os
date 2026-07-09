/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Cross-instance pinning test for lib/connections.ts.
 * Verifies that connState() is stored on globalThis so the same Map is returned
 * from any module instance in the same process (Next.js API-route bundles share state).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing connections.ts so the OpenSearch ping fails fast
// and getCache() initialises an empty in-process Map (offline mode).
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;
const { listConnectionsForUser, __resetConnections } = await import('./store.ts');

const CONN_KEY = Symbol.for('soa.connections.cache');
const user = { id: 'u1', name: 'U1', domains: ['sales'], role: 'admin' as const };

test('globalThis: soa.connections.cache — pinned Map survives across module calls', async () => {
  __resetConnections();
  // First call: warms the cache into globalThis.
  await listConnectionsForUser(user);
  const g = (globalThis as any)[CONN_KEY];
  assert.ok(g, 'globalThis key is set after first call');
  assert.ok(g.cache instanceof Map, 'cache is a Map on globalThis');
  const ref = g.cache;
  // Second call: must return the same cached Map, not a fresh instance.
  await listConnectionsForUser(user);
  assert.strictEqual(
    (globalThis as any)[CONN_KEY].cache,
    ref,
    'pinned: same Map instance returned on every call',
  );
});
