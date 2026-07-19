/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextAccessCap, emptyContextGrants, accessOf, isGranted } from '../core/context-grants.ts';
import { underFolder, expandSelectionToIds, reconcileGranted, type GrantableItem } from './grant-granularity.ts';

const items: GrantableItem[] = [
  { id: 'a', folder: '/reports', scope: 'personal' },
  { id: 'b', folder: '/reports/2026', scope: 'personal' },
  { id: 'c', folder: '/', scope: 'personal' },
  { id: 'd', folder: '/reports', scope: 'domain' }, // different scope
];

test('underFolder covers self, descendants, and the root', () => {
  assert.equal(underFolder('/reports', '/reports'), true);
  assert.equal(underFolder('/reports', '/reports/2026'), true);
  assert.equal(underFolder('/reports', '/other'), false);
  assert.equal(underFolder('/', '/anything/deep'), true);
});

test('expandSelectionToIds expands a folder grant to its scoped members + passes item grants', () => {
  const ids = expandSelectionToIds(items, [{ path: '/reports', scope: 'personal' }], ['c']);
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c'], 'folder grant pulls a+b (personal), item grant adds c; domain d excluded');
});

test('expandSelectionToIds with a root folder grant selects the whole scope', () => {
  const ids = expandSelectionToIds(items, [{ path: '/', scope: 'personal' }], []);
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c']);
});

test('reconcileGranted keeps existing access, adds new at cap default, drops de-selected', () => {
  const cap = contextAccessCap('read-propose');
  let grants = emptyContextGrants();
  grants = { ...grants, data: [{ id: 'a', access: 'read-write' }, { id: 'z', access: 'read-only' }] };
  // Note: 'a' persists (keep its read-write clamps nowhere since we keep as-is), 'z' dropped, 'b' added.
  const next = reconcileGranted(grants, 'data', new Set(['a', 'b']), cap);
  assert.equal(isGranted(next, 'data', 'a'), true);
  assert.equal(accessOf(next, 'data', 'a'), 'read-write', 'kept access untouched');
  assert.equal(isGranted(next, 'data', 'z'), false, 'de-selected dropped');
  assert.equal(accessOf(next, 'data', 'b'), 'read-propose', 'new added at cap default');
  // Purity
  assert.equal(isGranted(grants, 'data', 'b'), false);
});
