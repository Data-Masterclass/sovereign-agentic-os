/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore as resetFolders } from '../folders/folder-store.ts';
import { __resetStore as resetFiles, createFile, type Principal } from './store.ts';
import { filesAdapter } from './folder-adapter.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const user = { id: 'amir', role: 'creator', domains: ['sales'] };

beforeEach(() => { resetFiles(); resetFolders(); });

/**
 * BUG #1 REPRO (moved file doesn't land in the folder). A file's root is TIER-bound:
 * a private (dataset-tier) file lives in the PERSONAL tree. The old move picker offered
 * both the personal AND the domain root and sent only the `path`, so a personal file
 * "moved" into a folder shown under the domain root kept its personal root — and the
 * grid, filtering by the domain root, hid it. The fix (scope-driven single root) means
 * the adapter's PERSONAL-scope `itemsUnderFolder` MUST find the moved file at its new
 * path, and the DOMAIN scope must NOT (the two lanes never cross).
 */
test('BUG #1: a moved personal file is found under its new folder in the PERSONAL scope', () => {
  const a = createFile(amir, { name: 'contract.pdf', text: 'hello' });
  assert.equal(a.tier, 'dataset', 'a fresh upload is a private/personal-tier file');

  // Move it into /clients via the adapter (the same op the cascade + route use).
  filesAdapter.moveItem(a.id, user, '/clients');

  // Personal scope finds it under /clients (and under the root, incl. subfolders).
  const personalHit = filesAdapter.itemsUnderFolder(user, 'personal', '/clients');
  assert.deepEqual(personalHit.map((i) => i.id), [a.id], 'moved file appears under /clients');
  assert.equal(personalHit[0].folder, '/clients', 'its folder path is the destination');

  // The DOMAIN scope must NOT see this personal file — the lanes never cross, so a
  // domain-root folder picker could never have been a valid destination for it.
  const domainHit = filesAdapter.itemsUnderFolder(user, 'domain', '/clients');
  assert.deepEqual(domainHit.map((i) => i.id), [], 'a personal file never appears in the domain lane');
});

test('adapter itemsUnderFolder includes ARCHIVED members (so restore/delete can find them)', () => {
  const a = createFile(amir, { name: 'note.txt', text: 'x' });
  filesAdapter.moveItem(a.id, user, '/keep');
  filesAdapter.archiveItem(a.id, user);
  const hit = filesAdapter.itemsUnderFolder(user, 'personal', '/keep');
  assert.deepEqual(hit.map((i) => i.id), [a.id], 'archived member still enumerated for the cascade');
});
