/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createFolder,
  renameFolder,
  deleteFolder,
  listFolders,
  getFolder,
  FolderError,
  type Principal,
} from './folder-store.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' }; // owner, plain creator
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' }; // builder, amir's domain — NOT an admin
const dina: Principal = { id: 'dina', domains: ['sales'], role: 'domain_admin' }; // domain admin of sales
const sara: Principal = { id: 'sara', domains: ['ops'], role: 'admin' }; // platform admin, different domain
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'domain_admin' }; // admin of a DIFFERENT domain

beforeEach(() => { __resetStore(); });

test('createFolder: a personal folder is owned by its creator, path normalised', () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: 'contracts/' });
  assert.equal(f.path, '/contracts');
  assert.equal(f.name, 'contracts');
  assert.equal(f.owner, 'amir');
  assert.equal(f.scope, 'personal');
  assert.ok(f.id.startsWith('fld_'));
});

test('createFolder: the root is implicit and cannot be created', () => {
  assert.throws(() => createFolder(amir, { tab: 'files', scope: 'personal', path: '/' }), FolderError);
});

test('createFolder: a domain folder requires a domain the caller belongs to', () => {
  const ok = createFolder(dina, { tab: 'files', scope: 'domain', path: '/shared', domain: 'sales' });
  assert.equal(ok.domain, 'sales');
  assert.throws(
    () => createFolder(amir, { tab: 'files', scope: 'domain', path: '/x', domain: 'finance' }),
    (e: unknown) => e instanceof FolderError && e.status === 403,
  );
});

test('createFolder is idempotent on (tab, scope, path) — no duplicate row', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/c' });
  const b = createFolder(amir, { tab: 'files', scope: 'personal', path: '/c' });
  assert.equal(a.id, b.id);
  assert.equal(listFolders(amir, 'files', 'personal').length, 1);
});

// ---- governance gate: personal = owner only; domain = canManageArtifact ----

test('personal folder: only the OWNER (or platform admin) may manage it', () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: '/mine' });
  // A builder in the same domain must NOT touch another user's personal folder.
  assert.throws(() => renameFolder(bea, f.id, '/mine2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // A DOMAIN ADMIN of the domain still has no say over a private tree.
  assert.throws(() => renameFolder(dina, f.id, '/mine2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // The owner can.
  assert.equal(renameFolder(amir, f.id, '/mine2').path, '/mine2');
  // A platform admin can (tenant-wide), even from another domain.
  assert.equal(renameFolder(sara, f.id, '/mine3').path, '/mine3');
});

test('domain folder: owner, in-domain domain_admin, or platform admin may manage', () => {
  const f = createFolder(dina, { tab: 'files', scope: 'domain', path: '/team', domain: 'sales' });
  // The owner (dina) can; another domain's admin (kenji) cannot.
  assert.throws(() => renameFolder(kenji, f.id, '/team2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // A builder who is NOT the owner cannot mutate a shared folder (edit-scope rule).
  assert.throws(() => renameFolder(bea, f.id, '/team2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // A domain admin OF sales who is not the owner CAN (canManageArtifact).
  const f2 = createFolder(bea, { tab: 'files', scope: 'domain', path: '/beas', domain: 'sales' });
  assert.equal(renameFolder(dina, f2.id, '/beas-renamed').path, '/beas-renamed');
});

// -------------------------------------- delete: empty vs re-parent --------

test('deleteFolder: an EMPTY folder is removed', () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: '/tmp' });
  const res = deleteFolder(amir, f.id);
  assert.deepEqual(res.deleted, [f.id]);
  assert.equal(res.reparented.length, 0);
  assert.equal(getFolder(f.id), undefined);
});

test('deleteFolder: a NON-EMPTY folder RE-PARENTS its descendants, never orphans them', () => {
  const parent = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const child = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a/b' });
  const grand = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a/b/c' });
  const res = deleteFolder(amir, parent.id);
  assert.deepEqual(res.deleted, [parent.id]);
  // /a/b → /b and /a/b/c → /b/c (re-parented to root, /a's parent).
  assert.equal(getFolder(child.id)?.path, '/b');
  assert.equal(getFolder(grand.id)?.path, '/b/c');
  assert.equal(getFolder(parent.id), undefined, 'the deleted row is gone');
});

test('deleteFolder is edit-scoped (a non-owner is rejected, nothing deleted)', () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: '/keep' });
  assert.throws(() => deleteFolder(bea, f.id), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  assert.ok(getFolder(f.id), 'the folder still exists after a rejected delete');
});

// --------------------------------------------------- rename cascade -------

test('renameFolder rewrites the folder AND its descendant rows', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/proj' });
  const b = createFolder(amir, { tab: 'files', scope: 'personal', path: '/proj/docs' });
  renameFolder(amir, a.id, '/project');
  assert.equal(getFolder(a.id)?.path, '/project');
  assert.equal(getFolder(b.id)?.path, '/project/docs');
});

// ------------------------------------------------------ list scoping ------

test('listFolders scopes personal to the viewer and domain to the viewer\'s domains', () => {
  createFolder(amir, { tab: 'files', scope: 'personal', path: '/amir-only' });
  createFolder(bea, { tab: 'files', scope: 'personal', path: '/bea-only' });
  createFolder(dina, { tab: 'files', scope: 'domain', path: '/sales-shared', domain: 'sales' });

  // Personal: each viewer sees only their own.
  assert.deepEqual(listFolders(amir, 'files', 'personal').map((f) => f.path), ['/amir-only']);
  assert.deepEqual(listFolders(bea, 'files', 'personal').map((f) => f.path), ['/bea-only']);

  // Domain: a sales member sees the shared folder; a finance admin does not.
  assert.deepEqual(listFolders(amir, 'files', 'domain').map((f) => f.path), ['/sales-shared']);
  assert.deepEqual(listFolders(kenji, 'files', 'domain').map((f) => f.path), []);
});

test('listFolders is per-tab (a files folder never leaks into knowledge)', () => {
  createFolder(amir, { tab: 'files', scope: 'personal', path: '/f' });
  createFolder(amir, { tab: 'knowledge', scope: 'personal', path: '/k' });
  assert.deepEqual(listFolders(amir, 'files', 'personal').map((f) => f.path), ['/f']);
  assert.deepEqual(listFolders(amir, 'knowledge', 'personal').map((f) => f.path), ['/k']);
});
