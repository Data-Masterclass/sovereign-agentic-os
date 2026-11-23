/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `ensureFolderRow` — the one door that files an item's folder in the registry
 * USER STORY: As a creator I save into a Domain folder that already exists and see no false
 *             warning; when I file into an archived folder I am told, and nothing is revived
 *             behind anybody's back.
 * ARCHITECTURE:
 *   - The real folder registry, no mocks.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createFolder, ensureFolderRow, folderRowWarning, archiveFolderRows, listFolders, type Principal } from '@core/folders/index';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const dina: Principal = { id: 'dina', domains: ['sales'], role: 'domain_admin' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };

beforeEach(() => __resetStore());

test('a creator filing into a Domain folder that ALREADY exists gets "exists" — no false refusal', () => {
  const row = createFolder(dina, { tab: 'files', scope: 'domain', path: '/Finance/Out', domain: 'sales' });
  const r = ensureFolderRow(amir, { tab: 'files', scope: 'domain', path: 'Finance/Out/', domain: 'sales' });
  assert.equal(r.state, 'exists');
  assert.equal(r.state === 'exists' && r.folder.id, row.id);
  assert.equal(folderRowWarning(r), null);
});

test('a creator filing into a Domain folder that does NOT exist is refused (403) and told', () => {
  const r = ensureFolderRow(amir, { tab: 'files', scope: 'domain', path: '/New', domain: 'sales' });
  assert.equal(r.state, 'refused');
  assert.equal(r.state === 'refused' && r.status, 403);
  assert.match(folderRowWarning(r) ?? '', /could not be added/);
  assert.deepEqual(listFolders(dina, 'files', 'domain'), []);
});

test('a Domain row in a domain the caller is not a member of is never "seen" through this door', () => {
  createFolder(dina, { tab: 'files', scope: 'domain', path: '/X', domain: 'sales' });
  const r = ensureFolderRow(kenji, { tab: 'files', scope: 'domain', path: '/X', domain: 'sales' });
  assert.equal(r.state, 'refused');
});

test('an ARCHIVED row is reported, not revived and not duplicated', () => {
  const row = createFolder(amir, { tab: 'knowledge', scope: 'personal', path: '/results', domain: 'sales' });
  archiveFolderRows(amir, row.id);
  const r = ensureFolderRow(amir, { tab: 'knowledge', scope: 'personal', path: '/results', domain: 'sales' });
  assert.equal(r.state, 'archived');
  assert.match(folderRowWarning(r) ?? '', /archived; restore it/);
  const all = listFolders(amir, 'knowledge', 'personal', { includeArchived: true });
  assert.deepEqual(all.map((n) => [n.id, n.archived]), [[row.id, true]], 'still one row, still archived');
});
