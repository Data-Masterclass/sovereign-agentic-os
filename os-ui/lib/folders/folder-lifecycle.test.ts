/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerArtifactAdapter,
  __resetArtifactAdapters,
  type ArtifactAdapter,
  type AdapterItem,
  type AdapterPrincipal,
} from '../core/artifact-adapter.ts';
import { isUnderFolder } from '../core/folders.ts';
import { __resetStore, createFolder, getFolder, archiveFolderRows, type Principal } from './folder-store.ts';
import { moveFolder, archiveFolder, restoreFolder, deleteFolder } from './folder-lifecycle.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };

/** A tiny in-memory fake tab store the cascade drives — mirrors what a real tab
 *  adapter wraps. Items carry a `folder`, `archived` flag, and an `owner` so we can
 *  make one item edit-DENIED to prove the cascade is fail-closed. */
type Item = { id: string; folder: string; archived: boolean; owner: string; deleted: boolean };

function makeAdapter(items: Item[]): { adapter: ArtifactAdapter; items: Item[] } {
  const fail403 = (): never => {
    const e = new Error('forbidden') as Error & { status: number };
    e.status = 403;
    throw e;
  };
  const requireEdit = (it: Item, user: AdapterPrincipal): void => {
    // A stand-in edit gate: only the owner may act (so a cross-owner item throws 403).
    if (it.owner !== user.id && user.role !== 'admin') fail403();
  };
  const find = (id: string): Item => {
    const it = items.find((i) => i.id === id && !i.deleted);
    if (!it) {
      const e = new Error('not found') as Error & { status: number };
      e.status = 404;
      throw e;
    }
    return it;
  };
  const adapter: ArtifactAdapter = {
    tab: 'files',
    itemsUnderFolder: (_user, _scope, path) =>
      items
        .filter((i) => !i.deleted && isUnderFolder(path, i.folder))
        .map((i): AdapterItem => ({ id: i.id, folder: i.folder })),
    moveItem: (id, user, path) => { const it = find(id); requireEdit(it, user); it.folder = path; },
    archiveItem: (id, user) => { const it = find(id); requireEdit(it, user); it.archived = true; },
    restoreItem: (id, user) => { const it = find(id); requireEdit(it, user); it.archived = false; },
    deleteItem: (id, user) => { const it = find(id); requireEdit(it, user); it.deleted = true; },
  };
  return { adapter, items };
}

beforeEach(() => {
  __resetStore();
  __resetArtifactAdapters();
});

test('moveFolder reparents the folder ROW and rewrites every member ITEM path (Wave-2 gap closed)', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/proj' });
  const child = createFolder(amir, { tab: 'files', scope: 'personal', path: '/proj/docs' });
  const one = makeAdapter([
    { id: 'i1', folder: '/proj', archived: false, owner: 'amir', deleted: false },
    { id: 'i2', folder: '/proj/docs', archived: false, owner: 'amir', deleted: false },
    { id: 'i3', folder: '/other', archived: false, owner: 'amir', deleted: false },
  ]);
  registerArtifactAdapter(one.adapter);

  moveFolder(amir, 'files', a.id, '/project');
  assert.equal(getFolder(a.id)?.path, '/project', 'row moved');
  assert.equal(getFolder(child.id)?.path, '/project/docs', 'descendant row moved');
  assert.equal(one.items.find((i) => i.id === 'i1')!.folder, '/project', 'member item moved');
  assert.equal(one.items.find((i) => i.id === 'i2')!.folder, '/project/docs', 'deep member moved');
  assert.equal(one.items.find((i) => i.id === 'i3')!.folder, '/other', 'unrelated item untouched');
});

test('archiveFolder cascades archive to the rows AND every member item', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const one = makeAdapter([
    { id: 'i1', folder: '/a', archived: false, owner: 'amir', deleted: false },
    { id: 'i2', folder: '/a/b', archived: false, owner: 'amir', deleted: false },
    { id: 'i3', folder: '/keep', archived: false, owner: 'amir', deleted: false },
  ]);
  registerArtifactAdapter(one.adapter);
  archiveFolder(amir, 'files', a.id);
  assert.equal(getFolder(a.id)?.archived, true);
  assert.equal(one.items.find((i) => i.id === 'i1')!.archived, true);
  assert.equal(one.items.find((i) => i.id === 'i2')!.archived, true);
  assert.equal(one.items.find((i) => i.id === 'i3')!.archived, false, 'item outside the folder untouched');
});

test('restoreFolder reverses the archive cascade', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const one = makeAdapter([{ id: 'i1', folder: '/a', archived: false, owner: 'amir', deleted: false }]);
  registerArtifactAdapter(one.adapter);
  archiveFolder(amir, 'files', a.id);
  restoreFolder(amir, 'files', a.id);
  assert.notEqual(getFolder(a.id)?.archived, true);
  assert.equal(one.items.find((i) => i.id === 'i1')!.archived, false);
});

test('deleteFolder is ARCHIVED-ONLY and physically removes rows + member items', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const one = makeAdapter([{ id: 'i1', folder: '/a', archived: true, owner: 'amir', deleted: false }]);
  registerArtifactAdapter(one.adapter);
  // Live folder → refused.
  assert.throws(() => deleteFolder(amir, 'files', a.id), (e: unknown) => (e as { status?: number }).status === 409);
  // Archive, then delete.
  archiveFolder(amir, 'files', a.id);
  deleteFolder(amir, 'files', a.id);
  assert.equal(getFolder(a.id), undefined, 'row physically gone');
  assert.equal(one.items.find((i) => i.id === 'i1')!.deleted, true, 'member item physically deleted');
});

test('the cascade is FAIL-CLOSED: a member the caller cannot edit surfaces a 403', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  // One member is owned by someone else → the fake edit gate throws 403 for amir.
  const one = makeAdapter([
    { id: 'mine', folder: '/a', archived: false, owner: 'amir', deleted: false },
    { id: 'theirs', folder: '/a', archived: false, owner: 'bea', deleted: false },
  ]);
  registerArtifactAdapter(one.adapter);
  assert.throws(
    () => archiveFolder(amir, 'files', a.id),
    (e: unknown) => (e as { status?: number }).status === 403,
    'a denied member aborts the cascade rather than silently skipping governance',
  );
  void bea;
});

test('a missing adapter surfaces an honest 500 (a tab wired folders but forgot to register)', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  archiveFolderRows(amir, a.id); // archive the row directly (no adapter)
  assert.throws(
    () => deleteFolder(amir, 'files', a.id),
    (e: unknown) => (e as { status?: number }).status === 500,
  );
});
