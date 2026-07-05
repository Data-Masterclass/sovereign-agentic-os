/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tab visibility gate tests. Verifies that:
 *  - creator/builder never see Platform-group entries (except Tutorials)
 *  - admin sees all tabs
 *  - the "Platform" heading disappears for non-admins (filterTabGroups drops empty groups)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_GROUPS, tabVisible, filterTabGroups } from './tabs.ts';
import type { Role } from './session.ts';

// Flat label list for a given role after filtering.
function visibleLabels(role: Role): string[] {
  return filterTabGroups(TAB_GROUPS, role).flatMap((g) => g.tabs.map((t) => t.label));
}

// All Platform-group tab labels (for assertions).
const PLATFORM_GROUP = TAB_GROUPS.find((g) => g.heading === 'Platform')!;
assert.ok(PLATFORM_GROUP, 'Platform group must exist in TAB_GROUPS');
const PLATFORM_LABELS = PLATFORM_GROUP.tabs.map((t) => t.label);
const ADMIN_ONLY_PLATFORM = PLATFORM_LABELS.filter((l) => l !== 'Tutorials');

test('TAB-VIS creator: sees no admin-only Platform tabs (except Tutorials)', () => {
  const labels = visibleLabels('creator');
  for (const l of ADMIN_ONLY_PLATFORM) {
    assert.ok(!labels.includes(l), `creator must not see Platform tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'creator must see Tutorials');
});

test('TAB-VIS builder: sees no admin-only Platform tabs (except Tutorials)', () => {
  const labels = visibleLabels('builder');
  for (const l of ADMIN_ONLY_PLATFORM) {
    assert.ok(!labels.includes(l), `builder must not see Platform tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'builder must see Tutorials');
});

test('TAB-VIS admin: sees all tabs including every Platform tab', () => {
  const labels = visibleLabels('admin');
  for (const l of PLATFORM_LABELS) {
    assert.ok(labels.includes(l), `admin must see Platform tab: ${l}`);
  }
});

test('TAB-VIS filterTabGroups: Platform group is absent for creator/builder (no dangling heading)', () => {
  for (const role of ['creator', 'builder'] as Role[]) {
    const groups = filterTabGroups(TAB_GROUPS, role);
    const platformGroup = groups.find((g) => g.heading === 'Platform');
    // Tutorials is in the Platform group but has no minRole → the group still appears
    // with exactly one tab (Tutorials).
    assert.ok(platformGroup, `Platform group must still be present for ${role} (Tutorials is visible)`);
    assert.equal(platformGroup!.tabs.length, 1, `Platform group for ${role} must have exactly one tab (Tutorials)`);
    assert.equal(platformGroup!.tabs[0].label, 'Tutorials', `Platform group for ${role} must contain only Tutorials`);
  }
});

test('TAB-VIS tabVisible: minRole=admin gates creator and builder but allows admin', () => {
  const adminTab = { label: 'Admin', icon: '❖', href: '/platform', minRole: 'admin' as const };
  assert.equal(tabVisible(adminTab, 'creator'), false);
  assert.equal(tabVisible(adminTab, 'builder'), false);
  assert.equal(tabVisible(adminTab, 'admin'), true);
});

test('TAB-VIS tabVisible: no minRole is always visible to all roles', () => {
  const openTab = { label: 'Home', icon: '◇', href: '/' };
  assert.equal(tabVisible(openTab, 'creator'), true);
  assert.equal(tabVisible(openTab, 'builder'), true);
  assert.equal(tabVisible(openTab, 'admin'), true);
  assert.equal(tabVisible(openTab, null), true);
  assert.equal(tabVisible(openTab, undefined), true);
});

test('TAB-VIS tabVisible: null/undefined userRole passes (middleware handles auth redirect)', () => {
  const adminTab = { label: 'Admin', icon: '❖', href: '/platform', minRole: 'admin' as const };
  assert.equal(tabVisible(adminTab, null), true);
  assert.equal(tabVisible(adminTab, undefined), true);
});

test('TAB-VIS Tutorials has no minRole (all-roles visible)', () => {
  const tutTab = PLATFORM_GROUP.tabs.find((t) => t.label === 'Tutorials');
  assert.ok(tutTab, 'Tutorials tab must exist in Platform group');
  assert.equal(tutTab!.minRole, undefined, 'Tutorials must have no minRole (all-roles)');
});

test('TAB-VIS all other Platform tabs have minRole=admin', () => {
  for (const tab of PLATFORM_GROUP.tabs) {
    if (tab.label === 'Tutorials') continue;
    assert.equal(tab.minRole, 'admin', `Platform tab "${tab.label}" must have minRole: 'admin'`);
  }
});

test('TAB-VIS OS group tabs are visible to all roles', () => {
  const osGroup = TAB_GROUPS.find((g) => !g.heading)!;
  assert.ok(osGroup, 'OS group (no heading) must exist');
  for (const tab of osGroup.tabs) {
    // Marketplace and Governance have role hints but no minRole → visible to all roles
    assert.ok(tabVisible(tab, 'creator') === true || tab.minRole !== undefined,
      `OS group tab "${tab.label}" is unexpectedly hidden from creator`);
  }
  // Specifically: no OS group tab should have minRole set
  for (const tab of osGroup.tabs) {
    assert.equal(tab.minRole, undefined, `OS group tab "${tab.label}" must not have minRole`);
  }
});
