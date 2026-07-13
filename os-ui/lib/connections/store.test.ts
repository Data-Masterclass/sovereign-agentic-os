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
const { listConnectionsForUser, createConnection, promoteConnection, demoteConnection, getConnectionForUser, __resetConnections } = await import('./store.ts');

const CONN_KEY = Symbol.for('soa.connections.cache');
const user = { id: 'u1', name: 'U1', domains: ['sales'], role: 'admin' as const };
const builder = { id: 'u2', name: 'U2', domains: ['sales'], role: 'builder' as const };
const creator = { id: 'u3', name: 'U3', domains: ['sales'], role: 'creator' as const };

async function certifiedConn(owner = builder) {
  const c = await createConnection(owner, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  await promoteConnection(c.id, builder); // Personal → Shared
  await promoteConnection(c.id, user);    // Shared → Certified (admin)
  return c.id;
}

test('DEMOTE: revoke sharing lowers Certified → Shared → Personal one step at a time', async () => {
  __resetConnections();
  const id = await certifiedConn();
  assert.equal((await getConnectionForUser(id, user)).visibility, 'Certified');
  assert.equal((await demoteConnection(id, user)).visibility, 'Shared');     // admin revokes cert
  assert.equal((await demoteConnection(id, builder)).visibility, 'Personal'); // owner unshares
  await assert.rejects(() => demoteConnection(id, builder), /already Personal/i);
});

test('DEMOTE role gate: revoking a Certified connection requires an Administrator', async () => {
  __resetConnections();
  const id = await certifiedConn();
  await assert.rejects(() => demoteConnection(id, builder), /Administrator/i); // builder+owner, not admin
});

test('DEMOTE fail-closed: a creator cannot unshare a Shared connection they do not own', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'Shared DB', template: 'database', endpoint: '', credential: 'pw' });
  await promoteConnection(c.id, builder); // → Shared, owned by builder
  await assert.rejects(() => demoteConnection(c.id, creator), /owner or an in-domain Builder/i);
});

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
