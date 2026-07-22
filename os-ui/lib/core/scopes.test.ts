/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPE_GROUPS,
  scopeLabel,
  visibilityScope,
  visibilityLabel,
  promoteVerb,
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

test('the four internal keys are exactly all · mine · shared · marketplace, in order', () => {
  assert.deepEqual(SCOPE_GROUPS.map((g) => g.key), ['all', 'mine', 'shared', 'marketplace']);
});

test('scopeLabel renders the My · Domain · Company vocabulary', () => {
  assert.equal(scopeLabel('all'), 'All');
  assert.equal(scopeLabel('all', 'Data'), 'All Data');
  assert.equal(scopeLabel('mine', 'Data'), 'My Data');
  assert.equal(scopeLabel('mine', 'Files'), 'My Files');
  assert.equal(scopeLabel('mine'), 'My');
  assert.equal(scopeLabel('shared'), 'Domain');
  assert.equal(scopeLabel('shared', 'Data'), 'Domain Data');
  assert.equal(scopeLabel('marketplace'), 'Company');
  assert.equal(scopeLabel('marketplace', 'Data'), 'Company Data');
});

test('visibilityScope maps stored values to scope keys (internal values unchanged)', () => {
  assert.equal(visibilityScope('Personal'), 'mine');
  assert.equal(visibilityScope('Shared'), 'shared');
  assert.equal(visibilityScope('Certified'), 'marketplace');
  assert.equal(visibilityScope('Marketplace'), 'marketplace');
});

test('visibilityLabel renders the scope word for a stored visibility', () => {
  assert.equal(visibilityLabel('Personal'), 'My');
  assert.equal(visibilityLabel('Shared'), 'Domain');
  assert.equal(visibilityLabel('Certified'), 'Company');
  assert.equal(visibilityLabel('Shared', 'Data'), 'Domain Data');
});

test('promoteVerb reads Promote to Domain then Certify to Company', () => {
  assert.equal(promoteVerb('Personal'), 'Promote to Domain');
  assert.equal(promoteVerb('Personal', { propose: true }), 'Propose to Domain');
  assert.equal(promoteVerb('Shared'), 'Certify to Company');
});

test('All = the union of every group', () => {
  assert.deepEqual(groupByScope(groups, 'amir').all.map((x) => x.name), [
    'Zeta Personal', 'Old Personal', 'Amir Asset', 'Bea Asset', 'Certified Orders',
  ]);
});

test('My = the caller\'s OWN Personal-tier items only (a promoted asset leaves My)', () => {
  const mine = groupByScope(groups, 'amir').mine;
  // Only Amir's own Personal-tier files — NOT the Shared asset he authored
  // (that lives under Domain now), and NOT Bea's or Sara's.
  assert.deepEqual(mine.map((x) => x.name).sort(), ['Old Personal', 'Zeta Personal']);
  assert.ok(!mine.some((x) => x.tier === 'asset'), 'a promoted (Shared) item the caller owns is NOT under My');
});

test('Shared = the domain group; Marketplace = the marketplace group', () => {
  const g = groupByScope(groups, 'amir');
  assert.deepEqual(g.shared.map((x) => x.name), ['Amir Asset', 'Bea Asset']);
  assert.deepEqual(g.marketplace.map((x) => x.name), ['Certified Orders']);
});

test('an owner-authored Shared item appears under All and Shared, but NOT My', () => {
  const g = groupByScope(groups, 'amir');
  assert.ok(g.all.some((x) => x.name === 'Amir Asset'));
  assert.ok(g.shared.some((x) => x.name === 'Amir Asset'));
  assert.ok(!g.mine.some((x) => x.name === 'Amir Asset'), 'promoted → left My');
});

test('itemsForScope returns the right bucket', () => {
  assert.deepEqual(itemsForScope(groups, 'marketplace', 'amir').map((x) => x.name), ['Certified Orders']);
});

test('scopeCounts counts every visible item (archived included in the raw counts)', () => {
  assert.deepEqual(scopeCounts(groups, 'amir'), { all: 5, mine: 2, shared: 2, marketplace: 1 });
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
  assert.deepEqual(activeScopeCounts(groups, 'amir'), { all: 4, mine: 1, shared: 2, marketplace: 1 });
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
  // And the four-group slice puts only the caller's OWN Personal-tier item under
  // "My" — the Shared item 'b' they authored lives under Domain, not My.
  const scoped = groupByScope(g, 'amir');
  assert.deepEqual(scoped.mine.map((x) => x.name).sort(), ['a']);
});
