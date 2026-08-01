/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch BEFORE importing the store so the OpenSearch ping fails fast and the
// in-process cache initialises empty (offline mode) — same discipline as store.test.ts.
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { __resetStore: resetFolders } = await import('../folders/folder-store.ts');
const {
  __resetConnections,
  createConnection,
  promoteConnection,
  listConnectionsForUser,
} = await import('./store.ts');
const { connectionsAdapter } = await import('./folder-adapter.ts');

const builder = { id: 'u2', name: 'U2', domains: ['sales'], role: 'builder' as const };
const domainAdmin = { id: 'u4', name: 'U4', domains: ['sales'], role: 'domain_admin' as const };
const user = { id: 'u2', role: 'builder', domains: ['sales'] };

beforeEach(() => { __resetConnections(); resetFolders(); });

// The sync adapter ops (moveItem/archiveItem/deleteItem) intentionally `void` the store's
// best-effort mirror write-through — correct in production (the cascade is synchronous) but
// it leaves an async mirror write in flight. Drain it before the test ends so the offline
// fetch-stub rejection is handled INSIDE the test, not as a post-teardown uncaught rejection.
const settle = () => new Promise((r) => setTimeout(r, 0));

// A Personal connection lives in the PERSONAL tree. After a move, the personal-scope
// enumeration finds it at its new path and the domain scope never does — so a
// scope-driven single-root picker can only ever offer a valid destination.
test('a moved personal connection is found under its new folder in the PERSONAL scope only', async () => {
  const c = await createConnection(builder, { name: 'Prod', template: 'database', endpoint: '', credential: 'pw' });
  await listConnectionsForUser(builder); // warm the sync cache the sync adapter reads
  assert.equal(c.visibility, 'Personal', 'a fresh connection is Personal');
  connectionsAdapter.moveItem(c.id, user, '/finance');
  assert.deepEqual(
    connectionsAdapter.itemsUnderFolder(user, 'personal', '/finance').map((i) => i.id),
    [c.id],
  );
  assert.deepEqual(connectionsAdapter.itemsUnderFolder(user, 'domain', '/finance').map((i) => i.id), []);
  await settle();
});

// A Shared connection lives in the DOMAIN tree — the reverse of the personal case.
test('a shared connection lives in the DOMAIN scope, never the personal one', async () => {
  const c = await createConnection(builder, { name: 'Shared DB', template: 'database', endpoint: '', credential: 'pw' });
  await promoteConnection(c.id, domainAdmin); // Personal → Shared
  await listConnectionsForUser(builder);
  connectionsAdapter.moveItem(c.id, user, '/team');
  assert.deepEqual(connectionsAdapter.itemsUnderFolder(user, 'domain', '/team').map((i) => i.id), [c.id]);
  assert.deepEqual(connectionsAdapter.itemsUnderFolder(user, 'personal', '/team').map((i) => i.id), []);
  await settle();
});

// The restore/delete cascade must still find members the archive step already hid.
test('connections adapter itemsUnderFolder includes ARCHIVED members for the cascade', async () => {
  const c = await createConnection(builder, { name: 'Temp', template: 'database', endpoint: '', credential: 'pw' });
  await listConnectionsForUser(builder);
  connectionsAdapter.moveItem(c.id, user, '/keep');
  connectionsAdapter.archiveItem(c.id, user);
  assert.deepEqual(connectionsAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), [c.id]);
  // restore brings it back live; the member is still found under the same folder.
  connectionsAdapter.restoreItem(c.id, user);
  assert.deepEqual(connectionsAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), [c.id]);
  await settle();
});

// deleteItem physically forgets the record — the member vanishes from every scope.
test('connections adapter deleteItem removes the member from the cascade', async () => {
  const c = await createConnection(builder, { name: 'Gone', template: 'database', endpoint: '', credential: 'pw' });
  await listConnectionsForUser(builder);
  connectionsAdapter.moveItem(c.id, user, '/scratch');
  connectionsAdapter.deleteItem(c.id, user);
  assert.deepEqual(connectionsAdapter.itemsUnderFolder(user, 'personal', '/scratch').map((i) => i.id), []);
  await settle();
});