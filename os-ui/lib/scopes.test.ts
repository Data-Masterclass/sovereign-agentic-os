/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE_GROUPS,
  scopeLabel,
  groupByScope,
  groupsFromVisibility,
  itemsForScope,
  scopeCounts,
  tilesForScope,
  activeScopeCounts,
} from './scopes.ts';

type T = { name: string; owner: string; tier: string; archived?: boolean };
const t = (name: string, owner: string, tier: string, archived = false): T => ({ name, owner, tier, archived });

// The store payload shape: mine = own personal, domain = shared assets (any author),
// marketplace = certified products. Amir authored one of the shared assets.
const groups = {
  mine: [t('Zeta Personal', 'amir', 'dataset'), t('Old Personal', 'amir', 'dataset', true)],
  domain: [t('Amir Asset', 'amir', 'asset'), t('Bea Asset', 'bea', 'asset')],
  marketplace: [t('Certified Orders', 'sara', 'product')],
};

test('the four groups are exactly All · My · Shared · Marketplace, in order', () => {
  assert.deepEqual(SCOPE_GROUPS.map((g) => g.key), ['all', 'mine', 'shared', 'marketplace']);
});

test('scopeLabel renders "My <kind>" and plain group nouns', () => {
  assert.equal(scopeLabel('all'), 'All');
  assert.equal(scopeLabel('mine', 'Data'), 'My Data');
  assert.equal(scopeLabel('mine', 'Files'), 'My Files');
  assert.equal(scopeLabel('mine'), 'My');
  assert.equal(scopeLabel('shared'), 'Shared');
  assert.equal(scopeLabel('marketplace'), 'Marketplace');
});

test('All = the union of every group', () => {
  assert.deepEqual(groupByScope(groups, 'amir').all.map((x) => x.name), [
    'Zeta Personal', 'Old Personal', 'Amir Asset', 'Bea Asset', 'Certified Orders',
  ]);
});

test('My = OWNERSHIP across the whole union (a promoted asset the caller authored stays under My)', () => {
  const mine = groupByScope(groups, 'amir').mine;
  // Amir's own personal + the shared asset he authored, but NOT Bea's or Sara's.
  assert.deepEqual(mine.map((x) => x.name).sort(), ['Amir Asset', 'Old Personal', 'Zeta Personal']);
  assert.ok(mine.some((x) => x.tier === 'asset'), 'a Shared item the caller owns appears under My');
});

test('Shared = the domain group; Marketplace = the marketplace group', () => {
  const g = groupByScope(groups, 'amir');
  assert.deepEqual(g.shared.map((x) => x.name), ['Amir Asset', 'Bea Asset']);
  assert.deepEqual(g.marketplace.map((x) => x.name), ['Certified Orders']);
});

test('an owner-authored Shared item appears under BOTH All and Shared (and My)', () => {
  const g = groupByScope(groups, 'amir');
  assert.ok(g.all.some((x) => x.name === 'Amir Asset'));
  assert.ok(g.shared.some((x) => x.name === 'Amir Asset'));
  assert.ok(g.mine.some((x) => x.name === 'Amir Asset'));
});

test('itemsForScope returns the right bucket', () => {
  assert.deepEqual(itemsForScope(groups, 'marketplace', 'amir').map((x) => x.name), ['Certified Orders']);
});

test('scopeCounts counts every visible item (archived included in the raw counts)', () => {
  assert.deepEqual(scopeCounts(groups, 'amir'), { all: 5, mine: 3, shared: 2, marketplace: 1 });
});

test('tilesForScope splits active vs archived and sorts by name', () => {
  const r = tilesForScope(groups, 'all', 'amir');
  assert.deepEqual(r.active.map((x) => x.name), ['Amir Asset', 'Bea Asset', 'Certified Orders', 'Zeta Personal']);
  assert.deepEqual(r.archived.map((x) => x.name), ['Old Personal']);
});

test('tilesForScope falls back to title when there is no name', () => {
  const byTitle = {
    mine: [{ owner: 'amir', title: 'Beta' }, { owner: 'amir', title: 'Alpha' }],
    domain: [], marketplace: [],
  };
  assert.deepEqual(tilesForScope(byTitle, 'mine', 'amir').active.map((x) => x.title), ['Alpha', 'Beta']);
});

test('activeScopeCounts excludes archived items', () => {
  assert.deepEqual(activeScopeCounts(groups, 'amir'), { all: 4, mine: 2, shared: 2, marketplace: 1 });
});

test('groupsFromVisibility buckets a flat list by visibility (both tier vocabularies)', () => {
  const flat = [
    { owner: 'amir', visibility: 'Personal' as const, name: 'a' },
    { owner: 'amir', visibility: 'Shared' as const, name: 'b' },
    { owner: 'bea', visibility: 'Certified' as const, name: 'c' },
    { owner: 'sara', visibility: 'Marketplace' as const, name: 'd' },
  ];
  const g = groupsFromVisibility(flat);
  assert.deepEqual(g.mine.map((x) => x.name), ['a']);
  assert.deepEqual(g.domain.map((x) => x.name), ['b']);
  assert.deepEqual(g.marketplace.map((x) => x.name).sort(), ['c', 'd']);
  // And the four-group slice then follows ownership for "My".
  const scoped = groupByScope(g, 'amir');
  assert.deepEqual(scoped.mine.map((x) => x.name).sort(), ['a', 'b']);
});
