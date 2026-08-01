/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { createPillar, listPillarsSync, __resetForTests as resetPillars } from './pillars.ts';
import { pillarsAdapter } from './folder-adapter.ts';

// A tenant-wide admin who can edit any shared pillar; a creator who cannot.
const admin: Parameters<typeof createPillar>[0] = { id: 'admin', name: 'Admin', role: 'admin', domains: ['platform'] };
const owner: Parameters<typeof createPillar>[0] = { id: 'owner', name: 'Owner', role: 'creator', domains: ['sales'] };
const outsider = { id: 'outsider', role: 'creator', domains: ['ops'] };

// The AdapterPrincipal the cascade passes (role is a broad string).
const adminP = { id: 'admin', role: 'admin', domains: ['platform'] };
const ownerP = { id: 'owner', role: 'creator', domains: ['sales'] };

beforeEach(() => { resetPillars(); resetFolders(); });

function statusOf(e: unknown): number | undefined {
  return (e as { status?: number })?.status;
}

test('a moved tenant (Company) pillar is found under its new folder in the DOMAIN scope only', async () => {
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  pillarsAdapter.moveItem(p.id, adminP, '/north-star');
  assert.deepEqual(
    pillarsAdapter.itemsUnderFolder(adminP, 'domain', '/north-star').map((i) => i.id),
    [p.id],
    'a tenant pillar maps to the DOMAIN folder tree',
  );
  assert.deepEqual(
    pillarsAdapter.itemsUnderFolder(adminP, 'personal', '/north-star').map((i) => i.id),
    [],
    'and never appears in the personal tree',
  );
});

test('a moved personal (My) pillar is found under its new folder in the PERSONAL scope only', async () => {
  const p = await createPillar(owner, { name: 'My focus', scope: 'personal', domain: 'sales' });
  pillarsAdapter.moveItem(p.id, ownerP, '/ideas');
  assert.deepEqual(
    pillarsAdapter.itemsUnderFolder(ownerP, 'personal', '/ideas').map((i) => i.id),
    [p.id],
    'a personal pillar maps to the PERSONAL folder tree',
  );
  assert.deepEqual(pillarsAdapter.itemsUnderFolder(ownerP, 'domain', '/ideas').map((i) => i.id), []);
});

test('adapter itemsUnderFolder includes ARCHIVED members for the cascade', async () => {
  const p = await createPillar(admin, { name: 'Temp', scope: 'tenant' });
  pillarsAdapter.moveItem(p.id, adminP, '/keep');
  pillarsAdapter.archiveItem(p.id, adminP);
  assert.deepEqual(
    pillarsAdapter.itemsUnderFolder(adminP, 'domain', '/keep').map((i) => i.id),
    [p.id],
    'archived members are still visible to the restore/delete cascade',
  );
});

test('adapter ops are edit-scoped — an unauthorized caller throws 403 (fail-closed cascade)', async () => {
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  assert.throws(() => pillarsAdapter.moveItem(p.id, outsider, '/x'), (e) => statusOf(e) === 403);
  assert.throws(() => pillarsAdapter.archiveItem(p.id, outsider), (e) => statusOf(e) === 403);
});

test('deleteItem physically removes the pillar from the cache', async () => {
  const p = await createPillar(admin, { name: 'Retention', scope: 'tenant' });
  pillarsAdapter.moveItem(p.id, adminP, '/gone');
  pillarsAdapter.archiveItem(p.id, adminP);
  pillarsAdapter.deleteItem(p.id, adminP);
  assert.equal(listPillarsSync().some((x) => x.id === p.id), false, 'the pillar is gone from the cache');
});

test('scope mapping: folderScopeOfPillar routes tenant→domain, domain→domain, personal→personal', async () => {
  const t = await createPillar(admin, { name: 'Company', scope: 'tenant' });
  const my = await createPillar(owner, { name: 'Mine', scope: 'personal', domain: 'sales' });
  pillarsAdapter.moveItem(t.id, adminP, '/a');
  pillarsAdapter.moveItem(my.id, ownerP, '/a');
  // The tenant pillar lands in the domain lane, the personal one in the personal lane.
  assert.deepEqual(pillarsAdapter.itemsUnderFolder(adminP, 'domain', '/a').map((i) => i.id), [t.id]);
  assert.deepEqual(pillarsAdapter.itemsUnderFolder(ownerP, 'personal', '/a').map((i) => i.id), [my.id]);
});
