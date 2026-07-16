/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseFolderPath,
  pathSegments,
  parentPath,
  folderName,
  renamePrefix,
  isUnderFolder,
  itemsUnderFolder,
  buildTree,
  resolveFolderGrant,
  triState,
  visibleFolderRoots,
  renameLeafPath,
} from './folders.ts';

test('visibleFolderRoots: default shows both, active scope hides the inactive root', () => {
  // Backward-compatible default: no `roots` given → both roots render.
  assert.deepEqual(visibleFolderRoots(undefined), ['personal', 'domain']);
  // "My" scope → only the personal root renders (the empty Domain root is NOT shown).
  assert.deepEqual(visibleFolderRoots(['personal']), ['personal']);
  // "Domain"/"Company" scope → only the domain root renders (no bare "My folders").
  assert.deepEqual(visibleFolderRoots(['domain']), ['domain']);
  // Explicit both → both, in canonical order regardless of input order.
  assert.deepEqual(visibleFolderRoots(['domain', 'personal']), ['personal', 'domain']);
  // Empty request → nothing renders (neither root section).
  assert.deepEqual(visibleFolderRoots([]), []);
});

test('renameLeafPath: changes only the LEAF name, keeps the parent (the PATCH path)', () => {
  // Rename a nested folder → same parent /a, new leaf. This is the path the ••• Rename
  // action PATCHes to /api/folders/:id, distinct from a Move (which changes the parent).
  assert.equal(renameLeafPath('/a/b', 'c'), '/a/c');
  // A root-level folder renames within the root.
  assert.equal(renameLeafPath('/contracts', 'legal'), '/legal');
  // Name is trimmed + normalised (no stray slashes/spaces leak into the path).
  assert.equal(renameLeafPath('/a/b', '  c '), '/a/c');
  assert.equal(renameLeafPath('/a/b', 'c/d'), '/a/c/d');
  // Blank name → null (a no-op the caller skips — never issues a PATCH).
  assert.equal(renameLeafPath('/a/b', ''), null);
  assert.equal(renameLeafPath('/a/b', '   '), null);
});

test('normaliseFolderPath: leading slash, no trailing, root for empty', () => {
  assert.equal(normaliseFolderPath(undefined), '/');
  assert.equal(normaliseFolderPath(null), '/');
  assert.equal(normaliseFolderPath(''), '/');
  assert.equal(normaliseFolderPath('/'), '/');
  assert.equal(normaliseFolderPath('contracts'), '/contracts');
  assert.equal(normaliseFolderPath('/contracts/'), '/contracts');
  assert.equal(normaliseFolderPath(' contracts / 2026 '), '/contracts/2026');
  assert.equal(normaliseFolderPath('//a//b//'), '/a/b');
});

test('pathSegments / parentPath / folderName', () => {
  assert.deepEqual(pathSegments('/'), []);
  assert.deepEqual(pathSegments('/a/b'), ['a', 'b']);
  assert.equal(parentPath('/a/b'), '/a');
  assert.equal(parentPath('/a'), '/');
  assert.equal(parentPath('/'), '/');
  assert.equal(folderName('/a/b'), 'b');
  assert.equal(folderName('/'), '/');
});

test('renamePrefix rewrites descendants + the folder itself, leaves siblings alone', () => {
  assert.equal(renamePrefix('/a/b/c', '/a/b', '/a/x'), '/a/x/c');
  assert.equal(renamePrefix('/a/b', '/a/b', '/a/x'), '/a/x');
  assert.equal(renamePrefix('/other', '/a/b', '/a/x'), '/other');
  // A prefix that is a name-substring but NOT a path ancestor must not match.
  assert.equal(renamePrefix('/abc', '/a', '/z'), '/abc');
  assert.equal(renamePrefix('/a/b', '/a', '/z'), '/z/b');
});

test('isUnderFolder: prefix membership incl. subfolders; root contains all', () => {
  assert.ok(isUnderFolder('/', '/anything/deep'));
  assert.ok(isUnderFolder('/a', '/a'));
  assert.ok(isUnderFolder('/a', '/a/b'));
  assert.ok(!isUnderFolder('/a', '/ab')); // sibling, not a child
  assert.ok(!isUnderFolder('/a/b', '/a'));
});

test('itemsUnderFolder returns the folder + all descendants', () => {
  const items = [
    { id: '1', folder: '/a' },
    { id: '2', folder: '/a/b' },
    { id: '3', folder: '/a/b/c' },
    { id: '4', folder: '/other' },
  ];
  assert.deepEqual(itemsUnderFolder('/a', items).map((i) => i.id), ['1', '2', '3']);
  assert.deepEqual(itemsUnderFolder('/a/b', items).map((i) => i.id), ['2', '3']);
  assert.deepEqual(itemsUnderFolder('/other', items).map((i) => i.id), ['4']);
  assert.equal(itemsUnderFolder('/', items).length, 4);
});

test('buildTree nests rows and SYNTHESISES missing intermediate folders', () => {
  // Only a deep row exists — its ancestors must be synthesised so it renders.
  const tree = buildTree([{ path: '/a/b/c' }, { path: '/a/x' }]);
  assert.equal(tree.length, 1);
  const a = tree[0];
  assert.equal(a.path, '/a');
  assert.equal(a.synthetic, true, '/a has no row → synthetic');
  // /a has two children: b (synthetic) and x (real), sorted by name.
  assert.deepEqual(a.children.map((c) => c.name), ['b', 'x']);
  const b = a.children[0];
  assert.equal(b.synthetic, true);
  assert.equal(b.children[0].path, '/a/b/c');
  assert.equal(b.children[0].synthetic, false, 'the real row is not synthetic');
  const x = a.children[1];
  assert.equal(x.synthetic, false);
});

test('buildTree carries id + archived onto real rows, leaves synthetic ones bare', () => {
  const tree = buildTree([{ path: '/a/b', id: 'fld_b', archived: true }]);
  const a = tree[0]; // synthesised ancestor
  assert.equal(a.synthetic, true);
  assert.equal(a.id, undefined, 'a synthetic folder has no row id to act on');
  const b = a.children[0];
  assert.equal(b.synthetic, false);
  assert.equal(b.id, 'fld_b');
  assert.equal(b.archived, true);
});

test('buildTree: a real row supersedes a synthesised placeholder regardless of order', () => {
  const tree = buildTree([{ path: '/a/b' }, { path: '/a', name: 'Alpha' }]);
  const a = tree[0];
  assert.equal(a.path, '/a');
  assert.equal(a.synthetic, false);
  assert.equal(a.name, 'Alpha');
});

test('resolveFolderGrant: ids of scoped items under the folder, de-duped', () => {
  const scoped = [
    { id: 'f1', folder: '/contracts' },
    { id: 'f2', folder: '/contracts/2026' },
    { id: 'f3', folder: '/brand' },
  ];
  assert.deepEqual(resolveFolderGrant('/contracts', scoped), ['f1', 'f2']);
  assert.deepEqual(resolveFolderGrant('/', scoped), ['f1', 'f2', 'f3']);
  assert.deepEqual(resolveFolderGrant('/nope', scoped), []);
});

test('resolveFolderGrant can only ever be a SUBSET of the scoped list it is given', () => {
  // The caller already DLS-scoped this list; an item outside it can never appear.
  const scoped = [{ id: 'visible', folder: '/a' }];
  const ids = resolveFolderGrant('/', scoped);
  assert.ok(ids.every((id) => scoped.some((s) => s.id === id)));
});

test('triState: none / some / all; empty folder is none', () => {
  const all = ['a', 'b', 'c'];
  assert.equal(triState('/f', [], all), 'none');
  assert.equal(triState('/f', ['a'], all), 'some');
  assert.equal(triState('/f', ['a', 'b', 'c'], all), 'all');
  assert.equal(triState('/f', new Set(['a', 'b', 'c']), all), 'all');
  assert.equal(triState('/f', ['a', 'b', 'c'], []), 'none', 'empty folder is none');
});
