/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * REPRODUCTION: archive → restore a dataset through the REAL [id] route handler.
 * Drives POST {action:'unarchive'} exactly as the LifecycleActions Restore button
 * does, with `requireUser` mocked to the owner. Proves Restore un-archives (persisted)
 * and the dataset returns to the working list.
 */

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: { requireUser: async () => ACTING },
});

const { __resetStore, createDataset, archiveDataset, listDatasets } = await import('./store.ts');

beforeEach(() => __resetStore());

async function loadRoute() {
  return import(`../../app/api/data/datasets/[id]/route.ts?${Math.random()}`);
}

async function callPost(id: string, action: string) {
  const route = await loadRoute();
  const req = new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return route.POST(req, { params: Promise.resolve({ id }) });
}

async function callGet(id: string) {
  const route = await loadRoute();
  return route.GET(new Request('http://x'), { params: Promise.resolve({ id }) });
}

test('RESTORE: an archived dataset can be restored via the route and returns to the working list', async () => {
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
  const owner = { id: 'amir', domains: ['sales'], role: 'creator' as const };
  const d = createDataset(owner, { name: 'Orders' });
  archiveDataset(d.id, owner);
  assert.equal(listDatasets(owner).mine.length, 0, 'archived → hidden from working list');

  const res = await callPost(d.id, 'unarchive');
  assert.equal(res.status, 200, 'unarchive returns 200');
  const body = await res.json();
  assert.equal(body.dataset.archived, false, 'route reports the dataset as un-archived');

  assert.equal(listDatasets(owner).mine.length, 1, 'restored → back in the working list');
  assert.equal(listDatasets(owner).mine[0].archived, false);
});

test('DETAIL: GET reports the record-level archived flag (so detail shows Restore, not Archive)', async () => {
  ACTING = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
  const owner = { id: 'amir', domains: ['sales'], role: 'creator' as const };
  const d = createDataset(owner, { name: 'Orders' });

  const live = await (await callGet(d.id)).json();
  assert.equal(live.dataset.archived, false, 'live dataset reads archived:false');

  archiveDataset(d.id, owner);
  const arch = await (await callGet(d.id)).json();
  assert.equal(arch.dataset.archived, true, 'archived dataset reads archived:true');
});

test('RESTORE: a non-owner non-admin is denied (403)', async () => {
  const owner = { id: 'amir', domains: ['sales'], role: 'creator' as const };
  const d = createDataset(owner, { name: 'Orders' });
  archiveDataset(d.id, owner);

  ACTING = { id: 'bea', name: 'Bea', domains: ['sales'], role: 'builder' }; // non-owner builder
  const res = await callPost(d.id, 'unarchive');
  assert.equal(res.status, 403, 'non-owner non-admin cannot restore');
});
