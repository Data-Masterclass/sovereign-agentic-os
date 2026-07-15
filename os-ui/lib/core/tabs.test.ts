/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tab visibility gate tests for the consolidated nav. The six-section matrix:
 *   Ungrouped:  Home, Cockpit, Marketplace (entry-points, always visible, no heading)
 *   Plan:       Strategy, Big Bets, Workflows, MCP, Tutorials
 *   Context:    Knowledge, Files, Data, Connections, Metrics
 *   Build:      Agents, Software, Science, Dashboards
 *   Monitor:    Governance (builder+), Monitoring, Components (admin), LLM Gateway
 *   Admin:      Admin (admin), Terminal (admin), Query (admin), About / Licenses (admin)
 *
 * Governance (builders approve promotions — the sharing ladder) is oversight, so
 * it lives under Monitor (first tab), visible to builder+.
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
// These are spread across Monitor (Components) and Admin (Terminal, Admin, About / Licenses).
const ADMIN_ONLY_LABELS = TAB_GROUPS
  .flatMap((g) => g.tabs)
  .filter((t) => t.minRole === 'admin')
  .map((t) => t.label);

test('TAB-SET entry group is exactly Home + Cockpit + Tutorials + MCP', () => {
  assert.deepEqual(
    ENTRY_GROUP.tabs.map((t) => t.label),
    ['Home', 'Cockpit', 'Tutorials', 'MCP'],
  );
});

test('TAB-SET Plan group is Strategy, Big Bets, Workflows, Marketplace', () => {
  assert.deepEqual(
    PLAN_GROUP.tabs.map((t) => t.label),
    ['Strategy', 'Big Bets', 'Workflows', 'Marketplace'],
  );
});

test('TAB-SET Context group is Knowledge, Files, Data, Connections, Metrics', () => {
  assert.deepEqual(
    CONTEXT_GROUP.tabs.map((t) => t.label),
    ['Knowledge', 'Files', 'Data', 'Connections', 'Metrics'],
  );
});

test('TAB-SET Build group contains Agents, Software, Science, Dashboards', () => {
  assert.deepEqual(
    BUILD_GROUP.tabs.map((t) => t.label),
    ['Agents', 'Software', 'Science', 'Dashboards'],
  );
});

test('TAB-SET Monitor group contains Governance, Monitoring, Components, LLM Gateway', () => {
  assert.deepEqual(
    MONITOR_GROUP.tabs.map((t) => t.label),
    ['Governance', 'Monitoring', 'Components', 'LLM Gateway'],
  );
});

test('TAB-SET Admin group contains Admin, Terminal, Query, About / Licenses (no standalone Settings)', () => {
  assert.deepEqual(
    ADMIN_GROUP.tabs.map((t) => t.label),
    ['Admin', 'Terminal', 'Query', 'About / Licenses'],
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

test('TAB-SET Tutorials is in the entry group (under Cockpit) with no minRole', () => {
  const tut = ENTRY_GROUP.tabs.find((t) => t.label === 'Tutorials');
  assert.ok(tut, 'Tutorials must be in the entry group');
  assert.equal(tut!.minRole, undefined, 'Tutorials must have no minRole');
});

test('TAB-SET Marketplace is in the Plan group; MCP is in the entry group', () => {
  assert.ok(PLAN_GROUP.tabs.some((t) => t.label === 'Marketplace'), 'Marketplace under Plan');
  assert.ok(ENTRY_GROUP.tabs.some((t) => t.label === 'MCP'), 'MCP in the entry group');
  assert.ok(!ENTRY_GROUP.tabs.some((t) => t.label === 'Marketplace'), 'Marketplace no longer at the top');
});

test('TAB-VIS creator: sees no admin-only tabs at all', () => {
  const labels = visibleLabels('creator');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `creator must not see admin-only tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'creator must still see Tutorials');
  assert.ok(!labels.includes('Monitoring'), 'creator must not see Monitoring (builder+)');
  assert.ok(!labels.includes('LLM Gateway'), 'creator must not see LLM Gateway (builder+)');
  assert.ok(!labels.includes('MCP'), 'creator must not see the MCP setup tab (builder+); MCP connectivity is unaffected');
  assert.ok(!labels.includes('Governance'), 'creator must not see Governance (builder+)');
});

test('TAB-VIS builder sees the builder-gated tabs (Monitoring, LLM Gateway, MCP) that creators do not', () => {
  const b = visibleLabels('builder');
  const c = visibleLabels('creator');
  for (const l of ['Monitoring', 'LLM Gateway', 'MCP']) {
    assert.ok(b.includes(l), `builder must see ${l}`);
    assert.ok(!c.includes(l), `creator must not see ${l}`);
  }
});

test('TAB-VIS creator: Admin group is hidden entirely (all tabs are admin-only)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'creator');
  const admin = groups.find((g) => g.heading === 'Admin');
  assert.ok(!admin, 'Admin group must be absent for creator (all tabs are admin-gated)');
});

test('TAB-VIS builder: Monitor group includes Governance', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder');
  const monitor = groups.find((g) => g.heading === 'Monitor');
  assert.ok(monitor, 'Monitor group must be present for builder');
  assert.ok(monitor!.tabs.some((t) => t.label === 'Governance'), 'builder must see Governance');
});

test('TAB-VIS builder: Admin group is hidden entirely (all tabs are admin-only)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder');
  const admin = groups.find((g) => g.heading === 'Admin');
  assert.ok(!admin, 'Admin group must be absent for builder (all tabs are admin-gated)');
});

test('TAB-SET Query tab is in the Admin group between Terminal and About / Licenses', () => {
  const labels = ADMIN_GROUP.tabs.map((t) => t.label);
  const terminalIdx = labels.indexOf('Terminal');
  const queryIdx = labels.indexOf('Query');
  const aboutIdx = labels.indexOf('About / Licenses');
  assert.ok(queryIdx > terminalIdx, 'Query must come after Terminal');
  assert.ok(queryIdx < aboutIdx, 'Query must come before About / Licenses');
});

test('TAB-SET Query tab has minRole=admin and href=/admin-query', () => {
  const q = ADMIN_GROUP.tabs.find((t) => t.label === 'Query');
  assert.ok(q, 'Query tab must exist in Admin group');
  assert.equal(q!.minRole, 'admin', 'Query tab must have minRole: admin');
  assert.equal(q!.href, '/admin-query', 'Query tab must link to /admin-query');
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
  assert.ok(labels.includes('Tutorials'), 'admin must see Tutorials');
  assert.ok(!labels.includes('Settings'), 'standalone Settings tab must not appear in nav');
});

test('TAB-VIS Governance carries minRole=builder (builders approve promotions)', () => {
  const gov = MONITOR_GROUP.tabs.find((t) => t.label === 'Governance');
  assert.ok(gov, 'Governance tab must exist in the Monitor group');
  assert.equal(gov!.minRole, 'builder', 'Governance must have minRole builder');
  assert.equal(tabVisible(gov!, 'builder'), true);
  assert.equal(tabVisible(gov!, 'creator'), false);
});

test('TAB-VIS every gated tab carries a valid minRole (builder or admin)', () => {
  const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
  for (const tab of allTabs) {
    if (!tab.minRole) continue; // ungated — visible to all
    assert.ok(
      tab.minRole === 'builder' || tab.minRole === 'admin',
      `gated tab "${tab.label}" must have minRole builder or admin, got ${tab.minRole}`,
    );
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

test('TAB-VIS entry/Context/Build/Plan tabs are open to creators except the MCP setup tab', () => {
  // MCP is a builder+ setup tab wherever it lives (creators still connect via
  // /api/mcp); every other tab in these groups is open to creators.
  const openGroups = [ENTRY_GROUP, CONTEXT_GROUP, BUILD_GROUP, PLAN_GROUP];
  for (const group of openGroups) {
    for (const tab of group.tabs) {
      if (tab.label === 'MCP') {
        assert.equal(tab.minRole, 'builder', 'MCP setup tab is builder-gated');
        continue;
      }
      assert.equal(tab.minRole, undefined,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" must not have minRole`);
      assert.equal(tabVisible(tab, 'creator'), true,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" hidden from creator`);
    }
  }
});
