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
const { listConnectionsForUser, createConnection, promoteConnection, demoteConnection, getConnectionForUser, renameConnection, moveConnection, listConnectionsSync, __resetConnections } = await import('./store.ts');

const CONN_KEY = Symbol.for('soa.connections.cache');
const user = { id: 'u1', name: 'U1', domains: ['sales'], role: 'admin' as const };
const builder = { id: 'u2', name: 'U2', domains: ['sales'], role: 'builder' as const };
const creator = { id: 'u3', name: 'U3', domains: ['sales'], role: 'creator' as const };
// Promoting Personal→Shared now requires domain_admin+; `domainAdmin` is the in-domain approver.
const domainAdmin = { id: 'u4', name: 'U4', domains: ['sales'], role: 'domain_admin' as const };

async function certifiedConn(owner = builder) {
  const c = await createConnection(owner, { name: 'DB', template: 'database', endpoint: '', credential: 'pw' });
  await promoteConnection(c.id, domainAdmin); // Personal → Shared (domain_admin gate)
  await promoteConnection(c.id, user);        // Shared → Certified (admin)
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
  await promoteConnection(c.id, domainAdmin); // → Shared, owned by builder
  await assert.rejects(() => demoteConnection(c.id, creator), /owner|Domain admin|Administrator/i);
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

// ------------------------------------------- rename: display name + FROZEN identity --

test('renameConnection: FROZEN IDENTITY — a rename changes only name; principal/catalog/secret stay put', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'Prod DB', template: 'database', endpoint: '', credential: 'pw' });
  // Snapshot the frozen physical identity BEFORE the rename.
  const principalBefore = c.principal;              // conn-<slug>
  const secretNameBefore = c.secretRef.name;        // connection-<slug>
  const endpointBefore = c.endpoint;                // catalog / URL — never re-derived

  const renamed = await renameConnection(c.id, builder, 'Analytics DB');
  assert.equal(renamed.name, 'Analytics DB', 'display name changed');
  // The physical identity is FROZEN — none of it is name-derived after create.
  assert.equal(renamed.principal, principalBefore, 'principal (conn-<slug>) is frozen');
  assert.equal(renamed.secretRef.name, secretNameBefore, 'K8s secret name (connection-<slug>) is frozen');
  assert.equal(renamed.endpoint, endpointBefore, 'endpoint/catalog is frozen');

  // And it persisted (a re-read sees the new name + the same frozen identity).
  const after = await getConnectionForUser(c.id, builder);
  assert.equal(after.name, 'Analytics DB');
  assert.equal(after.principal, principalBefore);
  assert.equal(after.secretRef.name, secretNameBefore);
});

test('renameConnection: owner ok; a shared connection admits domain_admin; a non-owner non-admin is denied 403', async () => {
  __resetConnections();
  // A Personal connection owned by the builder — owner may rename, but nobody else.
  const personal = await createConnection(builder, { name: 'My Personal', template: 'database', endpoint: '', credential: 'pw' });
  assert.equal((await renameConnection(personal.id, builder, 'My Personal 2')).name, 'My Personal 2');
  // A different creator (not owner) cannot manage another user's PERSONAL connection.
  await assert.rejects(() => renameConnection(personal.id, creator, 'Hijack'), (e) => (e as { status?: number }).status === 403);

  // Promote to Shared so canManageArtifact admits an in-domain domain_admin.
  await promoteConnection(personal.id, domainAdmin); // Personal → Shared
  assert.equal((await renameConnection(personal.id, domainAdmin, 'Shared Renamed')).name, 'Shared Renamed');
  // A bare creator who is not the owner still may not rename a shared connection.
  await assert.rejects(() => renameConnection(personal.id, creator, 'Nope'), (e) => (e as { status?: number }).status === 403);
});

test('renameConnection: rejects an empty name (400) and no-ops an unchanged name', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'Keep', template: 'database', endpoint: '', credential: 'pw' });
  await assert.rejects(() => renameConnection(c.id, builder, '   '), (e) => (e as { status?: number }).status === 400);
  // No-op rename returns the same connection unchanged (no throw, same name).
  assert.equal((await renameConnection(c.id, builder, 'Keep')).name, 'Keep');
});

// ------------------------------------------------------------------ folder move --

test('moveConnection: sets a normalised folder path, edit-scoped, and persists', async () => {
  __resetConnections();
  const c = await createConnection(builder, { name: 'Foldered', template: 'database', endpoint: '', credential: 'pw' });
  await listConnectionsForUser(builder); // warm the sync cache for the sync move
  const moved = moveConnection(c.id, builder, 'Warehouses//Prod/');
  assert.equal(moved.folder, '/Warehouses/Prod', 'path is normalised');
  // A non-owner non-admin cannot move a personal connection.
  assert.throws(() => moveConnection(c.id, creator, '/elsewhere'), (e) => (e as { status?: number }).status === 403);
  // Persisted on a re-read.
  assert.equal((await getConnectionForUser(c.id, builder)).folder, '/Warehouses/Prod');
});
