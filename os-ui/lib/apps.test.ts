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
const {
  listAppsForUser,
  __resetAppsCache,
  createApp,
  updateAppDocs,
  promoteApp,
  removeAppInternal,
  listAppVersions,
  restoreAppVersion,
} = await import('./apps.ts');

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

// ---------------------------------------------------------------- versioning --

test('version history: updateAppDocs snapshots prior state; no-op does not churn', async () => {
  __resetAppsCache();
  const owner = { id: 'vh1', name: 'VH1', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'DocVApp', template: 'nextjs-supabase' });

  // No history before any edit.
  assert.equal((await listAppVersions(app.id, owner)).length, 0, 'no history before first edit');

  // First meaningful edit → one prior version captured.
  await updateAppDocs(app.id, owner, { designDecisions: 'v1 decisions' });
  const h1 = await listAppVersions(app.id, owner);
  assert.equal(h1.length, 1);
  assert.equal(h1[0].author, owner.id);
  assert.match(h1[0].summary, /edit docs/);

  // Identical re-save → no new version churn.
  await updateAppDocs(app.id, owner, { designDecisions: 'v1 decisions' });
  assert.equal((await listAppVersions(app.id, owner)).length, 1, 'no-op does not create a version');
});

test('version history: listed newest-first; multiple edits accumulate', async () => {
  __resetAppsCache();
  const owner = { id: 'vh2', name: 'VH2', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'MultiVApp', template: 'service' });

  await updateAppDocs(app.id, owner, { designDecisions: 'edit-1' });
  await updateAppDocs(app.id, owner, { designDecisions: 'edit-2' });
  const hist = await listAppVersions(app.id, owner);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].version, 2, 'newest first');
  assert.equal(hist[1].version, 1, 'oldest last');
});

test('version history: restore reverts content and snapshots current state first', async () => {
  __resetAppsCache();
  const owner = { id: 'vh3', name: 'VH3', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'RestoreVApp', template: 'script' });
  const original = app.designDecisions;

  // Edit → captures v1 (the original before the edit).
  await updateAppDocs(app.id, owner, { designDecisions: 'edited decisions' });

  // Restore v1 → content reverts to original; current "edited" state is
  // snapshotted as v2, making the restore itself auditable + reversible.
  const restored = await restoreAppVersion(app.id, owner, 1);
  assert.equal(restored.designDecisions, original, 'content reverts to the v1 snapshot');

  const hist = await listAppVersions(app.id, owner);
  assert.equal(hist.length, 2, 'restore snapshots current state → two versions total');
  assert.equal(hist[0].version, 2, 'newest first');
  assert.match(hist[0].summary, /restore of v1/);

  // Restoring a non-existent version throws 404.
  await assert.rejects(
    restoreAppVersion(app.id, owner, 99),
    (e: Error & { status?: number }) => { assert.equal(e.status, 404); return true; },
  );
});

test('version history: delete (removeAppInternal) purges the app version log', async () => {
  __resetAppsCache();
  const owner = { id: 'vh4', name: 'VH4', domains: ['sales'], role: 'admin' as const };
  const app = await createApp(owner, { name: 'DeleteVApp', template: 'dashboard' });
  await updateAppDocs(app.id, owner, { designDecisions: 'some content' });
  assert.equal((await listAppVersions(app.id, owner)).length, 1);

  await removeAppInternal(app.id);

  // A fresh app created afterwards has no leaked version history.
  const fresh = await createApp(owner, { name: 'FreshVApp', template: 'dashboard' });
  assert.equal((await listAppVersions(fresh.id, owner)).length, 0, 'purge leaves no leaked history');
});

test('version history: non-editor is rejected 403 on restore (view-list allowed)', async () => {
  __resetAppsCache();
  const owner  = { id: 'vh5owner',  name: 'Owner',  domains: ['sales'], role: 'admin'   as const };
  const viewer = { id: 'vh5viewer', name: 'Viewer', domains: ['sales'], role: 'creator' as const };

  const app = await createApp(owner, { name: 'SharedVApp', template: 'service' });
  // Promote to Shared so the viewer can see it (Personal is owner-only).
  await promoteApp(app.id, owner);
  await updateAppDocs(app.id, owner, { designDecisions: 'shared content' });

  // Viewer can LIST the version history (view-scoped).
  const hist = await listAppVersions(app.id, viewer);
  assert.equal(hist.length, 1, 'viewer can list versions');

  // But viewer cannot RESTORE (edit-scoped) — must get 403.
  await assert.rejects(
    restoreAppVersion(app.id, viewer, 1),
    (e: Error & { status?: number }) => { assert.equal(e.status, 403); return true; },
  );
});
