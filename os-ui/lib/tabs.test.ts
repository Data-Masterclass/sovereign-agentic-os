/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tab visibility gate tests for the consolidated nav. The five-section matrix:
 *   Ungrouped:  Home, Cockpit (entry-points, always visible, no heading)
 *   Plan:       Strategy, Big Bets
 *   Context:    Knowledge, Files, Data, Connections
 *   Build:      Agents, Software, Science, MCP, LLM Gateway, Marketplace
 *   Monitor:    Metrics, Dashboards, Monitoring
 *   Admin:      Governance (builder+), Components (admin), Terminal (admin),
 *               Admin (admin), Settings, Tutorials, About / Licenses (admin)
 *
 * Governance (builders approve promotions — the sharing ladder) is oversight, so
 * it lives under Admin alongside the admin-only consoles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_GROUPS, tabVisible, filterTabGroups } from './tabs.ts';
import type { Role } from './session.ts';

// Flat label list for a given role after filtering.
function visibleLabels(role: Role): string[] {
  return filterTabGroups(TAB_GROUPS, role).flatMap((g) => g.tabs.map((t) => t.label));
}

const ENTRY_GROUP  = TAB_GROUPS.find((g) => !g.heading)!;
const PLAN_GROUP   = TAB_GROUPS.find((g) => g.heading === 'Plan')!;
const CONTEXT_GROUP = TAB_GROUPS.find((g) => g.heading === 'Context')!;
const BUILD_GROUP  = TAB_GROUPS.find((g) => g.heading === 'Build')!;
const MONITOR_GROUP = TAB_GROUPS.find((g) => g.heading === 'Monitor')!;
const ADMIN_GROUP  = TAB_GROUPS.find((g) => g.heading === 'Admin')!;

assert.ok(ENTRY_GROUP,   'Entry group (no heading) must exist in TAB_GROUPS');
assert.ok(PLAN_GROUP,    'Plan group must exist in TAB_GROUPS');
assert.ok(CONTEXT_GROUP, 'Context group must exist in TAB_GROUPS');
assert.ok(BUILD_GROUP,   'Build group must exist in TAB_GROUPS');
assert.ok(MONITOR_GROUP, 'Monitor group must exist in TAB_GROUPS');
assert.ok(ADMIN_GROUP,   'Admin group must exist in TAB_GROUPS');

// Admin-gated console tabs (the tabs a creator/builder never sees).
const ADMIN_ONLY_LABELS = ADMIN_GROUP.tabs
  .filter((t) => t.minRole === 'admin')
  .map((t) => t.label);

test('TAB-SET entry group is exactly Home + Cockpit', () => {
  assert.deepEqual(
    ENTRY_GROUP.tabs.map((t) => t.label),
    ['Home', 'Cockpit'],
  );
});

test('TAB-SET Plan group is Strategy + Big Bets', () => {
  assert.deepEqual(
    PLAN_GROUP.tabs.map((t) => t.label),
    ['Strategy', 'Big Bets'],
  );
});

test('TAB-SET Context group is Knowledge, Files, Data, Connections', () => {
  assert.deepEqual(
    CONTEXT_GROUP.tabs.map((t) => t.label),
    ['Knowledge', 'Files', 'Data', 'Connections'],
  );
});

test('TAB-SET Build group contains Agents, Software, Science, MCP, LLM Gateway, Marketplace', () => {
  assert.deepEqual(
    BUILD_GROUP.tabs.map((t) => t.label),
    ['Agents', 'Software', 'Science', 'MCP', 'LLM Gateway', 'Marketplace'],
  );
});

test('TAB-SET Monitor group contains Metrics, Dashboards, Monitoring', () => {
  assert.deepEqual(
    MONITOR_GROUP.tabs.map((t) => t.label),
    ['Metrics', 'Dashboards', 'Monitoring'],
  );
});

test('TAB-SET Admin group contains Governance, Components, Terminal, Admin, Settings, Tutorials, About / Licenses', () => {
  assert.deepEqual(
    ADMIN_GROUP.tabs.map((t) => t.label),
    ['Governance', 'Components', 'Terminal', 'Admin', 'Settings', 'Tutorials', 'About / Licenses'],
  );
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

test('TAB-SET Tutorials is in the Admin group with no minRole', () => {
  const tut = ADMIN_GROUP.tabs.find((t) => t.label === 'Tutorials');
  assert.ok(tut, 'Tutorials must be in the Admin group');
  assert.equal(tut!.minRole, undefined, 'Tutorials must have no minRole');
});

test('TAB-VIS creator: sees no admin-only tabs at all', () => {
  const labels = visibleLabels('creator');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `creator must not see admin-only tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'creator must still see Tutorials');
  assert.ok(labels.includes('Monitoring'), 'creator must still see Monitoring');
  assert.ok(!labels.includes('Governance'), 'creator must not see Governance (builder+)');
});

test('TAB-VIS creator: Admin group drops the admin-gated tabs but Settings + Tutorials remain', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'creator');
  const admin = groups.find((g) => g.heading === 'Admin');
  assert.ok(admin, 'Admin group must still be present for creator (Settings + Tutorials visible)');
  const labels = admin!.tabs.map((t) => t.label);
  assert.ok(labels.includes('Settings'), 'Settings must remain');
  assert.ok(labels.includes('Tutorials'), 'Tutorials must remain');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `admin-only tab "${l}" must be absent for creator`);
  }
});

test('TAB-VIS builder: Admin group includes Governance', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder');
  const admin = groups.find((g) => g.heading === 'Admin');
  assert.ok(admin, 'Admin group must be present for builder');
  assert.ok(admin!.tabs.some((t) => t.label === 'Governance'), 'builder must see Governance');
});

test('TAB-VIS builder: Admin group still shows only Settings + Tutorials (no admin consoles)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder');
  const admin = groups.find((g) => g.heading === 'Admin');
  assert.ok(admin, 'Admin group must be present for builder');
  const labels = admin!.tabs.map((t) => t.label);
  assert.ok(labels.includes('Settings'));
  assert.ok(labels.includes('Tutorials'));
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `admin-only tab "${l}" must be absent for builder`);
  }
});

test('TAB-VIS domain_admin: sees no admin-only tabs', () => {
  const labels = visibleLabels('domain_admin');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `domain_admin must not see admin-only tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'domain_admin must see Tutorials');
  assert.ok(labels.includes('Governance'), 'domain_admin must see Governance (builder+)');
});

test('TAB-VIS admin: sees all tabs', () => {
  const labels = visibleLabels('admin');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(labels.includes(l), `admin must see tab: ${l}`);
  }
  assert.ok(labels.includes('Governance'), 'admin must see Governance');
  assert.ok(labels.includes('Settings'), 'admin must see Settings');
  assert.ok(labels.includes('Tutorials'), 'admin must see Tutorials');
});

test('TAB-VIS Governance carries minRole=builder (builders approve promotions)', () => {
  const gov = ADMIN_GROUP.tabs.find((t) => t.label === 'Governance');
  assert.ok(gov, 'Governance tab must exist in the Admin group');
  assert.equal(gov!.minRole, 'builder', 'Governance must have minRole builder');
  assert.equal(tabVisible(gov!, 'builder'), true);
  assert.equal(tabVisible(gov!, 'creator'), false);
});

test('TAB-VIS admin-only console tabs all have minRole=admin', () => {
  for (const tab of ADMIN_GROUP.tabs) {
    if (!tab.minRole) continue; // Settings and Tutorials have no minRole — that's correct
    if (tab.label === 'Governance') continue; // builder-level oversight, not an admin-only console
    assert.equal(tab.minRole, 'admin', `Admin console "${tab.label}" must have minRole: 'admin'`);
  }
});

test('TAB-VIS tabVisible: minRole=admin gates creator, builder AND domain_admin but allows admin', () => {
  const adminTab = { label: 'Admin', icon: '❖', href: '/platform', minRole: 'admin' as const };
  assert.equal(tabVisible(adminTab, 'creator'), false);
  assert.equal(tabVisible(adminTab, 'builder'), false);
  assert.equal(tabVisible(adminTab, 'domain_admin'), false, 'domain_admin never reaches admin-only tabs');
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

test('TAB-VIS entry + Plan + Context + Build tabs have no minRole (visible to all)', () => {
  const alwaysVisibleGroups = [ENTRY_GROUP, PLAN_GROUP, CONTEXT_GROUP, BUILD_GROUP];
  for (const group of alwaysVisibleGroups) {
    for (const tab of group.tabs) {
      assert.equal(tab.minRole, undefined,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" must not have minRole`);
      assert.equal(tabVisible(tab, 'creator'), true,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" hidden from creator`);
    }
  }
});
