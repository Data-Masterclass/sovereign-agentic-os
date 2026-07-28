/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createFolder,
  renameFolder,
  archiveFolderRows,
  restoreFolderRows,
  deleteFolderRows,
  folderAndDescendants,
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

test('personal folder: ONLY the OWNER may manage it (no admin, no domain_admin)', () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: '/mine' });
  // A builder in the same domain must NOT touch another user's personal folder.
  assert.throws(() => renameFolder(bea, f.id, '/mine2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // A DOMAIN ADMIN of the domain has no say over a private tree.
  assert.throws(() => renameFolder(dina, f.id, '/mine2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // A PLATFORM ADMIN also has NO say over another user's private tree (privacy is
  // absolute for the personal tier — the manage-rights rule).
  assert.throws(() => renameFolder(sara, f.id, '/mine3'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // The owner can.
  assert.equal(renameFolder(amir, f.id, '/mine2').path, '/mine2');
});

test('domain folder: owner, in-domain domain_admin, or platform admin may manage', () => {
  const f = createFolder(dina, { tab: 'files', scope: 'domain', path: '/team', domain: 'sales' });
  // The owner (dina, a domain_admin) can; another domain's admin (kenji) cannot.
  assert.throws(() => renameFolder(kenji, f.id, '/team2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // A builder who is NOT the owner cannot mutate a shared folder (edit-scope rule).
  assert.throws(() => renameFolder(bea, f.id, '/team2'), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // The owner (in-domain domain_admin) renames it.
  assert.equal(renameFolder(dina, f.id, '/team2').path, '/team2');
  // A PLATFORM ADMIN (tenant-wide, even from another domain) may manage it too.
  assert.equal(renameFolder(sara, f.id, '/team3').path, '/team3');
});

test('domain folder CREATION requires domain_admin+ (a builder/creator cannot)', () => {
  // A builder proposes to Domain but does not mint domain-level structure.
  assert.throws(() => createFolder(bea, { tab: 'files', scope: 'domain', path: '/nope', domain: 'sales' }),
    (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  assert.throws(() => createFolder(amir, { tab: 'files', scope: 'domain', path: '/nope', domain: 'sales' }),
    (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  // A creator/builder CAN create their own personal folder freely.
  assert.ok(createFolder(bea, { tab: 'files', scope: 'personal', path: '/beas' }));
  // An in-domain domain_admin CREATES a domain folder.
  assert.ok(createFolder(dina, { tab: 'files', scope: 'domain', path: '/ok', domain: 'sales' }));
});

// -------------------------------- archive → restore → delete lifecycle -----

test('archiveFolderRows: archives the folder ROW + its descendant rows, reversibly', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const b = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a/b' });
  const other = createFolder(amir, { tab: 'files', scope: 'personal', path: '/other' });
  archiveFolderRows(amir, a.id);
  assert.equal(getFolder(a.id)?.archived, true);
  assert.equal(getFolder(b.id)?.archived, true, 'descendant row archived too');
  assert.ok(getFolder(a.id)?.archivedAt, 'archivedAt stamped');
  assert.notEqual(getFolder(other.id)?.archived, true, 'a sibling folder is untouched');
});

test('listFolders hides archived folders by default, shows them with includeArchived', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  createFolder(amir, { tab: 'files', scope: 'personal', path: '/live' });
  archiveFolderRows(amir, a.id);
  assert.deepEqual(listFolders(amir, 'files', 'personal').map((f) => f.path), ['/live']);
  assert.deepEqual(
    listFolders(amir, 'files', 'personal', { includeArchived: true }).map((f) => f.path).sort(),
    ['/a', '/live'],
  );
});

test('restoreFolderRows reverses archive on the folder + descendants', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const b = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a/b' });
  archiveFolderRows(amir, a.id);
  restoreFolderRows(amir, a.id);
  assert.notEqual(getFolder(a.id)?.archived, true);
  assert.notEqual(getFolder(b.id)?.archived, true);
  assert.equal(getFolder(a.id)?.archivedAt, undefined, 'archivedAt cleared on restore');
});

test('deleteFolderRows: PHYSICAL delete is ARCHIVED-ONLY', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  // A live folder cannot be physically deleted — archive first.
  assert.throws(
    () => deleteFolderRows(amir, a.id),
    (e: unknown) => e instanceof FolderError && (e as FolderError).status === 409,
  );
  assert.ok(getFolder(a.id), 'still present after a refused physical delete');
  archiveFolderRows(amir, a.id);
  const deleted = deleteFolderRows(amir, a.id);
  assert.deepEqual(deleted, [a.id]);
  assert.equal(getFolder(a.id), undefined, 'archived folder is now physically gone');
});

test('deleteFolderRows removes the folder ROW + every descendant row', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const b = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a/b' });
  const grand = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a/b/c' });
  archiveFolderRows(amir, a.id);
  const deleted = deleteFolderRows(amir, a.id).sort();
  assert.deepEqual(deleted, [a.id, b.id, grand.id].sort());
  assert.equal(getFolder(a.id), undefined);
  assert.equal(getFolder(b.id), undefined);
  assert.equal(getFolder(grand.id), undefined);
});

test('folder lifecycle row ops are edit-scoped (a non-owner is rejected, nothing changes)', () => {
  const f = createFolder(amir, { tab: 'files', scope: 'personal', path: '/keep' });
  assert.throws(() => archiveFolderRows(bea, f.id), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  assert.notEqual(getFolder(f.id)?.archived, true, 'not archived after a rejected op');
  archiveFolderRows(amir, f.id);
  assert.throws(() => deleteFolderRows(bea, f.id), (e: unknown) => e instanceof FolderError && (e as FolderError).status === 403);
  assert.ok(getFolder(f.id), 'the folder still exists after a rejected delete');
});

test('folderAndDescendants returns the folder + its descendant rows in the same lane', () => {
  const a = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a' });
  const b = createFolder(amir, { tab: 'files', scope: 'personal', path: '/a/b' });
  createFolder(amir, { tab: 'files', scope: 'personal', path: '/ab' }); // name-substring, NOT a child
  const paths = folderAndDescendants(getFolder(a.id)!).map((n) => n.path).sort();
  assert.deepEqual(paths, ['/a', '/a/b']);
  void b;
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

// ─────────────────────────── domain-scoped folder isolation ────────────────
// These tests prove the fix for the bug: "folder trees are NOT domain-specific".
// A personal folder created under domain A must NOT appear when the active
// domain is B, same-named folders in A and B must be distinct rows, and
// null/undefined activeDomain means "All" (shows both).

// A user who belongs to BOTH sales and ops — multi-domain principal.
const bi: Principal = { id: 'bi', domains: ['sales', 'ops'], role: 'creator' };
// bi acting as domain_admin so they can create domain folders
const biAdmin: Principal = { id: 'bi', domains: ['sales', 'ops'], role: 'domain_admin' };

test('personal folder created under domain A is NOT listed when activeDomain=B', () => {
  // Create /work stamped in 'sales'.
  const f = createFolder(bi, { tab: 'files', scope: 'personal', path: '/work', domain: 'sales' });
  assert.equal(f.domain, 'sales');

  // activeDomain=sales → visible.
  const inSales = listFolders(bi, 'files', 'personal', { activeDomain: 'sales' }).map((x) => x.path);
  assert.deepEqual(inSales, ['/work']);

  // activeDomain=ops → NOT visible.
  const inOps = listFolders(bi, 'files', 'personal', { activeDomain: 'ops' }).map((x) => x.path);
  assert.deepEqual(inOps, []);
});

test('same-named personal folders in domain A and B are distinct rows', () => {
  const fSales = createFolder(bi, { tab: 'files', scope: 'personal', path: '/work', domain: 'sales' });
  const fOps = createFolder(bi, { tab: 'files', scope: 'personal', path: '/work', domain: 'ops' });

  // They are separate rows.
  assert.notEqual(fSales.id, fOps.id);

  // Each is visible only under its own domain.
  const inSales = listFolders(bi, 'files', 'personal', { activeDomain: 'sales' });
  assert.deepEqual(inSales.map((x) => x.id), [fSales.id]);

  const inOps = listFolders(bi, 'files', 'personal', { activeDomain: 'ops' });
  assert.deepEqual(inOps.map((x) => x.id), [fOps.id]);
});

test('activeDomain=null (All) shows folders from every domain the viewer owns', () => {
  createFolder(bi, { tab: 'files', scope: 'personal', path: '/work', domain: 'sales' });
  createFolder(bi, { tab: 'files', scope: 'personal', path: '/work', domain: 'ops' });

  // null → All — both appear (sorted by path; same path so order is stable by insertion via sort stability).
  const all = listFolders(bi, 'files', 'personal', { activeDomain: null });
  assert.equal(all.length, 2);
  assert.ok(all.every((f) => f.path === '/work'));
});

test('domain (shared) folder tier is also scoped by activeDomain', () => {
  const salesAdmin: Principal = { id: 'salesadmin', domains: ['sales'], role: 'domain_admin' };
  const opsAdmin: Principal = { id: 'opsadmin', domains: ['ops'], role: 'domain_admin' };

  createFolder(salesAdmin, { tab: 'files', scope: 'domain', path: '/team', domain: 'sales' });
  createFolder(opsAdmin, { tab: 'files', scope: 'domain', path: '/team', domain: 'ops' });

  // bi belongs to both; with activeDomain=sales only the sales folder surfaces.
  const inSales = listFolders(bi, 'files', 'domain', { activeDomain: 'sales' }).map((x) => x.domain);
  assert.deepEqual(inSales, ['sales']);

  const inOps = listFolders(bi, 'files', 'domain', { activeDomain: 'ops' }).map((x) => x.domain);
  assert.deepEqual(inOps, ['ops']);

  // null → both.
  const all = listFolders(bi, 'files', 'domain', { activeDomain: null });
  assert.equal(all.length, 2);
});

test('folderAndDescendants is scoped to (owner, domain) for personal — cross-domain subtrees do not cascade', () => {
  const fSales = createFolder(bi, { tab: 'files', scope: 'personal', path: '/a', domain: 'sales' });
  const childSales = createFolder(bi, { tab: 'files', scope: 'personal', path: '/a/b', domain: 'sales' });
  const fOps = createFolder(bi, { tab: 'files', scope: 'personal', path: '/a', domain: 'ops' });
  const childOps = createFolder(bi, { tab: 'files', scope: 'personal', path: '/a/b', domain: 'ops' });

  const salesDescendants = folderAndDescendants(getFolder(fSales.id)!).map((n) => n.id).sort();
  assert.deepEqual(salesDescendants, [fSales.id, childSales.id].sort());

  const opsDescendants = folderAndDescendants(getFolder(fOps.id)!).map((n) => n.id).sort();
  assert.deepEqual(opsDescendants, [fOps.id, childOps.id].sort());

  void childSales; void childOps;
});

test('createFolder personal: idempotent is keyed on (owner, domain, path) — distinct rows for different domains', () => {
  // Same path, same owner, different domain → two distinct rows.
  const a = createFolder(bi, { tab: 'knowledge', scope: 'personal', path: '/notes', domain: 'sales' });
  const b = createFolder(bi, { tab: 'knowledge', scope: 'personal', path: '/notes', domain: 'ops' });
  assert.notEqual(a.id, b.id);

  // Same path, same owner, same domain → idempotent (returns existing row).
  const a2 = createFolder(bi, { tab: 'knowledge', scope: 'personal', path: '/notes', domain: 'sales' });
  assert.equal(a2.id, a.id);
});

test('single-domain users are unaffected: no activeDomain filter acts like before', () => {
  // Amir is single-domain (sales). A single-domain user with no activeDomain restriction
  // still sees all their own folders, same as before this change.
  createFolder(amir, { tab: 'files', scope: 'personal', path: '/mine' });
  const all = listFolders(amir, 'files', 'personal', { activeDomain: null });
  assert.equal(all.length, 1);
  assert.equal(all[0].path, '/mine');

  // activeDomain='sales' also works — they only have sales folders anyway.
  const scoped = listFolders(amir, 'files', 'personal', { activeDomain: 'sales' });
  assert.equal(scoped.length, 1);
});

void biAdmin; // prevent unused-variable lint
