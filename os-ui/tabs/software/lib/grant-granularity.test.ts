/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextAccessCap, emptyContextGrants, accessOf, isGranted } from '@core/kernel/context-grants';
import { underFolder, expandSelectionToIds, reconcileGranted, isPersonalDataGrantRisk, PERSONAL_DATA_GRANT_WARNING, type GrantableItem } from './grant-granularity.ts';

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

test('reconcileGranted KEEPS a grant the narrowed feed never listed (out-of-domain)', () => {
  // The available-context feed is scoped to the ACTIVE domain, so an app granted an artifact
  // in another domain is never offered that id — it cannot be in the tree's selection. Reading
  // that absence as a de-selection deleted the grant on the first tick anywhere in the picker.
  const cap = contextAccessCap('read-propose');
  let grants = emptyContextGrants();
  grants = {
    ...grants,
    data: [
      { id: 'ds_local', access: 'read-only' },
      { id: 'ds_foreign', access: 'read-write' },
    ],
  };
  const listed = new Set(['ds_local', 'ds_other_local']);
  const next = reconcileGranted(grants, 'data', new Set(['ds_local']), cap, listed);
  assert.equal(isGranted(next, 'data', 'ds_foreign'), true, 'the unlisted grant survives');
  assert.equal(accessOf(next, 'data', 'ds_foreign'), 'read-write', 'with its access intact');
  assert.equal(isGranted(next, 'data', 'ds_local'), true, 'the selected one stays');
});

test('reconcileGranted still DROPS a listed grant the user de-selected', () => {
  const cap = contextAccessCap('read-propose');
  let grants = emptyContextGrants();
  grants = { ...grants, data: [{ id: 'ds_local', access: 'read-only' }] };
  const next = reconcileGranted(grants, 'data', new Set<string>(), cap, new Set(['ds_local']));
  assert.equal(isGranted(next, 'data', 'ds_local'), false, 'de-selecting something shown removes it');
});

test('reconcileGranted KEEPS a MARKETPLACE grant the tree never offered', () => {
  // Marketplace items have their own picker and are not tree-tickable, so `listed` is the TREE's
  // ids. Counting the whole feed as listed deleted every marketplace grant on the first tick.
  const cap = contextAccessCap('read-propose');
  let grants = emptyContextGrants();
  grants = {
    ...grants,
    data: [{ id: 'ds_local', access: 'read-only' }, { id: 'ds_certified', access: 'read-only' }],
  };
  const listedTreeIds = new Set(['ds_local']);
  const next = reconcileGranted(grants, 'data', new Set(['ds_local']), cap, listedTreeIds);
  assert.equal(isGranted(next, 'data', 'ds_certified'), true, 'the marketplace grant survives');
  assert.equal(isGranted(next, 'data', 'ds_local'), true, 'the ticked one stays');
});

// -------------------- Personal-DATA grant warning (0.6.115 C1) --

test('C1: a Personal-scoped DATA grant surfaces the access-denied risk', () => {
  assert.equal(isPersonalDataGrantRisk('data', 'personal'), true, 'personal data → warn');
  assert.match(PERSONAL_DATA_GRANT_WARNING, /Only you can read this dataset/);
  assert.match(PERSONAL_DATA_GRANT_WARNING, /access-denied/);
});

test('C1: Domain / marketplace data and non-data kinds do NOT warn', () => {
  assert.equal(isPersonalDataGrantRisk('data', 'domain'), false, 'domain data is shared — no warn');
  assert.equal(isPersonalDataGrantRisk('data', 'marketplace'), false, 'marketplace data is discoverable — no warn');
  assert.equal(isPersonalDataGrantRisk('data', undefined), false, 'unknown scope — no warn');
  // A personal KNOWLEDGE/FILES/CONNECTIONS/METRICS grant is not this warning's concern.
  for (const k of ['knowledge', 'files', 'connections', 'metrics'] as const) {
    assert.equal(isPersonalDataGrantRisk(k, 'personal'), false, `${k} personal is not the data warning`);
  }
});
