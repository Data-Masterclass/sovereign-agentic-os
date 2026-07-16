/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { __resetStore as resetData, createDataset, type Principal } from './store.ts';
import { dataAdapter } from './folder-adapter.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const user = { id: 'amir', role: 'creator', domains: ['sales'] };

beforeEach(() => { resetData(); resetFolders(); });

// Same class as Files' bug #1: a private (dataset-tier) dataset lives in the PERSONAL
// tree. After a move, the personal-scope enumeration finds it at its new path and the
// domain scope never does — so a scope-driven single-root picker can only ever offer a
// valid destination. (Confirms the bug does NOT also exist in Data.)
test('a moved personal dataset is found under its new folder in the PERSONAL scope only', () => {
  const d = createDataset(amir, { name: 'Orders' });
  assert.equal(d.tier, 'dataset', 'a fresh dataset is personal-tier');
  dataAdapter.moveItem(d.id, user, '/finance');
  assert.deepEqual(
    dataAdapter.itemsUnderFolder(user, 'personal', '/finance').map((i) => i.id),
    [d.id],
  );
  assert.deepEqual(dataAdapter.itemsUnderFolder(user, 'domain', '/finance').map((i) => i.id), []);
});

test('data adapter itemsUnderFolder includes ARCHIVED members for the cascade', () => {
  const d = createDataset(amir, { name: 'Temp' });
  dataAdapter.moveItem(d.id, user, '/keep');
  dataAdapter.archiveItem(d.id, user);
  assert.deepEqual(dataAdapter.itemsUnderFolder(user, 'personal', '/keep').map((i) => i.id), [d.id]);
});
