/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantFolderNodes } from './grant-folders.ts';

/**
 * The agent grant picker's folder-node builder — proves the Files-blank bug is fixed:
 * folders are synthesized from item PATHS (the implicit-rail model) and UNIONED with the
 * explicit registry rows, each carrying its scope.
 */

test('Files with folder paths but NO registry rows still yield scoped folder nodes', () => {
  // The bug: files carry a folder path but no explicit folder row → feed returned [].
  const items = [
    { folder: '/Contracts', scope: 'personal' as const },
    { folder: '/Contracts/2026', scope: 'personal' as const },
    { folder: '/Shared', scope: 'domain' as const },
  ];
  const nodes = grantFolderNodes([], items);
  // Every ancestor along each path, at the item's scope; no root node; deduped.
  assert.deepEqual(new Set(nodes), new Set([
    { path: '/Contracts', scope: 'personal' },
    { path: '/Contracts/2026', scope: 'personal' },
    { path: '/Shared', scope: 'domain' },
  ]));
  // The picker splits by scope exactly as FolderResourcePicker does — both non-empty.
  assert.ok(nodes.some((n) => n.scope === 'personal'));
  assert.ok(nodes.some((n) => n.scope === 'domain'));
});

test('explicit registry rows are included (incl. empty folders) and deduped against paths', () => {
  const explicit = [
    { path: '/Empty', scope: 'personal' as const },   // an empty folder — no item under it
    { path: '/Contracts', scope: 'personal' as const }, // also has an item below
  ];
  const items = [{ folder: '/Contracts/2026', scope: 'personal' as const }];
  const nodes = grantFolderNodes(explicit, items);
  const paths = nodes.filter((n) => n.scope === 'personal').map((n) => n.path).sort();
  assert.deepEqual(paths, ['/Contracts', '/Contracts/2026', '/Empty']);
  // '/Contracts' appears once despite being both an explicit row and a path ancestor.
  assert.equal(nodes.filter((n) => n.path === '/Contracts' && n.scope === 'personal').length, 1);
});

test('root-folder items and marketplace items contribute no tree node', () => {
  const items = [
    { folder: '/', scope: 'personal' as const },        // root is implicit
    { folder: undefined, scope: 'personal' as const },  // no folder at all
    { folder: '/Certified', scope: 'marketplace' as const }, // marketplace has no tree
  ];
  assert.deepEqual(grantFolderNodes([], items), []);
});

test('the same personal path under two scopes stays distinct', () => {
  const items = [
    { folder: '/Reports', scope: 'personal' as const },
    { folder: '/Reports', scope: 'domain' as const },
  ];
  const nodes = grantFolderNodes([], items);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.some((n) => n.path === '/Reports' && n.scope === 'personal'));
  assert.ok(nodes.some((n) => n.path === '/Reports' && n.scope === 'domain'));
});
