/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tab visibility gate tests for the consolidated nav. The matrix:
 *  - creator: OS group only — NO Platform tabs at all (the group heading drops)
 *  - builder: OS group + exactly one Platform tab (Governance — builders
 *    approve promotions there; that keeps the sharing ladder working)
 *  - admin: everything (Governance, Admin, Components, Terminal, About / Licenses)
 * Tutorials lives in the OS group (directly above Settings), visible to all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_GROUPS, tabVisible, filterTabGroups } from './tabs.ts';
import type { Role } from './session.ts';

// Flat label list for a given role after filtering.
function visibleLabels(role: Role): string[] {
  return filterTabGroups(TAB_GROUPS, role).flatMap((g) => g.tabs.map((t) => t.label));
}

const OS_GROUP = TAB_GROUPS.find((g) => !g.heading)!;
const PLATFORM_GROUP = TAB_GROUPS.find((g) => g.heading === 'Platform')!;
assert.ok(OS_GROUP, 'OS group (no heading) must exist in TAB_GROUPS');
assert.ok(PLATFORM_GROUP, 'Platform group must exist in TAB_GROUPS');
const PLATFORM_LABELS = PLATFORM_GROUP.tabs.map((t) => t.label);

test('TAB-SET Platform group is exactly the five consolidated tabs, in order', () => {
  assert.deepEqual(PLATFORM_LABELS, [
    'Governance',
    'Admin',
    'Components',
    'Terminal',
    'About / Licenses',
  ]);
});

test('TAB-SET removed tabs are gone from the nav entirely', () => {
  const all = TAB_GROUPS.flatMap((g) => g.tabs);
  for (const label of ['Users', 'Gateway', 'Orchestration', 'Consoles', 'Workbench']) {
    assert.ok(!all.some((t) => t.label === label), `removed tab "${label}" must not be in the nav`);
  }
  for (const href of ['/users', '/gateway', '/orchestration', '/consoles', '/workbench']) {
    assert.ok(!all.some((t) => t.href === href), `removed route "${href}" must not be in the nav`);
  }
});

test('TAB-SET Tutorials is in the OS group, directly above Settings, no minRole', () => {
  const labels = OS_GROUP.tabs.map((t) => t.label);
  const tut = labels.indexOf('Tutorials');
  const settings = labels.indexOf('Settings');
  assert.ok(tut > -1, 'Tutorials must be an OS-group tab');
  assert.equal(settings, tut + 1, 'Tutorials must sit directly above Settings');
  assert.equal(OS_GROUP.tabs[tut].minRole, undefined, 'Tutorials must have no minRole');
});

test('TAB-VIS creator: sees NO Platform tabs at all', () => {
  const labels = visibleLabels('creator');
  for (const l of PLATFORM_LABELS) {
    assert.ok(!labels.includes(l), `creator must not see Platform tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'creator must still see Tutorials (OS group)');
  assert.ok(labels.includes('Monitoring'), 'creator must still see Monitoring (OS group)');
});

test('TAB-VIS creator: Platform group is dropped entirely (no dangling heading)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'creator');
  assert.equal(groups.find((g) => g.heading === 'Platform'), undefined,
    'Platform group must be absent for creator');
});

test('TAB-VIS builder: Platform group is exactly Governance', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder');
  const platform = groups.find((g) => g.heading === 'Platform');
  assert.ok(platform, 'Platform group must be present for builder');
  assert.deepEqual(platform!.tabs.map((t) => t.label), ['Governance'],
    'builder must see Governance and nothing else in Platform');
});

test('TAB-VIS domain_admin: sees NO admin-only Platform tab (the 0.1.31 gating stays closed)', () => {
  const labels = visibleLabels('domain_admin');
  // Admin-only Platform tabs = every Platform tab EXCEPT Governance (builder+).
  const adminOnlyPlatform = PLATFORM_LABELS.filter((l) => l !== 'Governance');
  for (const l of adminOnlyPlatform) {
    assert.ok(!labels.includes(l), `domain_admin must not see Platform tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'domain_admin must see Tutorials');
  assert.ok(labels.includes('Governance'), 'domain_admin must see Governance (builder+)');
});

test('TAB-VIS admin: sees all tabs including every Platform tab', () => {
  const labels = visibleLabels('admin');
  for (const l of PLATFORM_LABELS) {
    assert.ok(labels.includes(l), `admin must see Platform tab: ${l}`);
  }
});

test('TAB-VIS Governance carries minRole=builder (NOT admin — builders approve promotions)', () => {
  const gov = PLATFORM_GROUP.tabs.find((t) => t.label === 'Governance');
  assert.ok(gov, 'Governance tab must exist in the Platform group');
  assert.equal(gov!.minRole, 'builder', 'Governance must have minRole builder');
  assert.equal(tabVisible(gov!, 'builder'), true);
  assert.equal(tabVisible(gov!, 'creator'), false);
});

test('TAB-VIS all Platform tabs except Governance have minRole=admin', () => {
  for (const tab of PLATFORM_GROUP.tabs) {
    if (tab.label === 'Governance') continue;
    assert.equal(tab.minRole, 'admin', `Platform tab "${tab.label}" must have minRole: 'admin'`);
  }
});

test('TAB-VIS tabVisible: minRole=admin gates creator, builder AND domain_admin but allows admin', () => {
  const adminTab = { label: 'Admin', icon: '❖', href: '/platform', minRole: 'admin' as const };
  assert.equal(tabVisible(adminTab, 'creator'), false);
  assert.equal(tabVisible(adminTab, 'builder'), false);
  assert.equal(tabVisible(adminTab, 'domain_admin'), false, 'domain_admin never reaches Platform tabs');
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

test('TAB-VIS OS group tabs are visible to all roles (no minRole anywhere)', () => {
  for (const tab of OS_GROUP.tabs) {
    assert.equal(tab.minRole, undefined, `OS group tab "${tab.label}" must not have minRole`);
    assert.equal(tabVisible(tab, 'creator'), true, `OS group tab "${tab.label}" hidden from creator`);
  }
});
