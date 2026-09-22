/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Offline-stub fetch BEFORE importing apps.ts (same discipline as apps.test.ts) so the
// store initialises an empty in-process Map with no cluster.
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { createApp, moveApp, promoteApp, __resetAppsCache } = await import('./apps.ts');
const { archiveApp } = await import('./lifecycle.ts');
const { softwareAdapter } = await import('./folder-adapter.ts');

// The cascade calls the adapter with a bare principal (id/role/domains).
const owner = { id: 'sa1', name: 'SA1', domains: ['sales'], role: 'creator' as const };
const principal = { id: 'sa1', role: 'creator', domains: ['sales'] };

test('software adapter: registered on the "software" tab', () => {
  assert.equal(softwareAdapter.tab, 'software');
});

test('software adapter: a moved Personal app is found under its new folder in the PERSONAL scope only', async () => {
  __resetAppsCache();
  const app = await createApp(owner, { name: 'Orders App', template: 'service' });
  await moveApp(app.id, owner, '/finance');
  assert.deepEqual(
    softwareAdapter.itemsUnderFolder(principal, 'personal', '/finance').map((i) => i.id),
    [app.id],
    'personal scope finds the moved app at its new path',
  );
  assert.deepEqual(
    softwareAdapter.itemsUnderFolder(principal, 'domain', '/finance').map((i) => i.id),
    [],
    'domain scope never sees a Personal app',
  );
});

test('software adapter: itemsUnderFolder includes ARCHIVED members (the restore/delete cascade needs them)', async () => {
  __resetAppsCache();
  const app = await createApp(owner, { name: 'Temp App', template: 'service' });
  await moveApp(app.id, owner, '/keep');
  await archiveApp(app.id, owner);
  assert.deepEqual(
    softwareAdapter.itemsUnderFolder(principal, 'personal', '/keep').map((i) => i.id),
    [app.id],
    'an archived app is still enumerated so the cascade can find it',
  );
});

test('software adapter: a Shared app lives in the DOMAIN lane, not the personal one', async () => {
  __resetAppsCache();
  const domainAdmin = { id: 'da1', name: 'DA1', domains: ['sales'], role: 'domain_admin' as const };
  const daPrincipal = { id: 'da1', role: 'domain_admin', domains: ['sales'] };
  const app = await createApp(owner, { name: 'Shared App', template: 'service' });
  await moveApp(app.id, owner, '/shared-folder');
  await promoteApp(app.id, domainAdmin); // Personal → Shared (domain_admin gate)
  // Now the app is Shared → its folder lives in the DOMAIN tree.
  assert.deepEqual(
    softwareAdapter.itemsUnderFolder(daPrincipal, 'domain', '/shared-folder').map((i) => i.id),
    [app.id],
    'a Shared app is enumerated in the domain scope',
  );
  assert.deepEqual(
    softwareAdapter.itemsUnderFolder(daPrincipal, 'personal', '/shared-folder').map((i) => i.id),
    [],
    'a Shared app is NOT in the personal scope',
  );
});
