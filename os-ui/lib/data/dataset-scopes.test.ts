/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesForScope, scopeCounts, DATASET_SCOPES } from './dataset-scopes.ts';

type T = { name: string; owner: string; tier: string; archived?: boolean };
const t = (name: string, owner: string, tier: string, archived = false): T => ({ name, owner, tier, archived });

// The listDatasets shape: mine = own personal, domain = shared assets (any author),
// marketplace = certified products. Amir authored one of the shared assets.
const groups = {
  mine: [t('Zeta Personal', 'amir', 'dataset'), t('Old Personal', 'amir', 'dataset', true)],
  domain: [t('Amir Asset', 'amir', 'asset'), t('Bea Asset', 'bea', 'asset')],
  marketplace: [t('Certified Orders', 'sara', 'product')],
};

test('the scope switcher offers exactly All · My · Domain · Company', () => {
  assert.deepEqual(DATASET_SCOPES.map((s) => s.label), ['All Data', 'My Data', 'Domain Data', 'Company Data']);
});

test('All Data = the union of every group (sorted, archived split out)', () => {
  const r = tilesForScope(groups, 'all', 'amir');
  assert.deepEqual(r.active.map((x) => x.name), ['Amir Asset', 'Bea Asset', 'Certified Orders', 'Zeta Personal']);
  assert.deepEqual(r.archived.map((x) => x.name), ['Old Personal']);
});

test('My Data = OWNERSHIP, regardless of tier (an asset the caller authored stays under My Data)', () => {
  const r = tilesForScope(groups, 'mine', 'amir');
  assert.deepEqual(r.active.map((x) => x.name), ['Amir Asset', 'Zeta Personal']);
});

test('Shared Data = domain assets; Marketplace Data = certified products', () => {
  assert.deepEqual(tilesForScope(groups, 'shared', 'amir').active.map((x) => x.name), ['Amir Asset', 'Bea Asset']);
  assert.deepEqual(tilesForScope(groups, 'marketplace', 'amir').active.map((x) => x.name), ['Certified Orders']);
});

test('archived tiles never appear in the working list, and counts exclude them', () => {
  const r = tilesForScope(groups, 'mine', 'amir');
  assert.ok(!r.active.some((x) => x.archived));
  assert.deepEqual(r.archived.map((x) => x.name), ['Old Personal']);
  const counts = scopeCounts(groups, 'amir');
  assert.deepEqual(counts, { all: 4, mine: 2, shared: 2, marketplace: 1 });
});
