/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tab visibility gate tests for the consolidated nav. The five-section matrix
 * (5 tabs each):
 *   Ungrouped (entry): Home, Cockpit, Tutorials, MCP (builder+), About / Licenses
 *   Plan:    Strategy, Big Bets, Operating Manual, Workflows, Marketplace
 *   Context: Knowledge, Files, Data, Connections, Metrics
 *   Build:   Agents, Software, Science, Dashboards, Console (admin)
 *   Govern:  Policies & Approvals (builder+), Monitoring (builder+),
 *            Components (admin), LLM Gateway (builder+), Admin (admin)
 *
 * The former Admin group was dissolved: Admin moved to Govern, Terminal+Query
 * merged into Console (Build group), About/Licenses moved to Entry.
 * Monitor was renamed Govern. Governance tab was relabelled Policies & Approvals
 * (route /governance unchanged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_GROUPS, tabVisible, filterTabGroups } from './tabs.ts';
import type { Role } from './session.ts';

// Flat label list for a given role after filtering.
function visibleLabels(role: Role): string[] {
  return filterTabGroups(TAB_GROUPS, role).flatMap((g) => g.tabs.map((t) => t.label));
}

const ENTRY_GROUP   = TAB_GROUPS.find((g) => !g.heading)!;
const PLAN_GROUP    = TAB_GROUPS.find((g) => g.heading === 'Plan')!;
const CONTEXT_GROUP = TAB_GROUPS.find((g) => g.heading === 'Context')!;
const BUILD_GROUP   = TAB_GROUPS.find((g) => g.heading === 'Build')!;
const GOVERN_GROUP  = TAB_GROUPS.find((g) => g.heading === 'Govern')!;

assert.ok(ENTRY_GROUP,   'Entry group (no heading) must exist in TAB_GROUPS');
assert.ok(PLAN_GROUP,    'Plan group must exist in TAB_GROUPS');
assert.ok(CONTEXT_GROUP, 'Context group must exist in TAB_GROUPS');
assert.ok(BUILD_GROUP,   'Build group must exist in TAB_GROUPS');
assert.ok(GOVERN_GROUP,  'Govern group must exist in TAB_GROUPS');

// The former Monitor and Admin groups must be gone.
const MONITOR_GROUP = TAB_GROUPS.find((g) => g.heading === 'Monitor');
const ADMIN_GROUP   = TAB_GROUPS.find((g) => g.heading === 'Admin');

assert.ok(!MONITOR_GROUP, 'Monitor group must be dissolved (renamed to Govern)');
assert.ok(!ADMIN_GROUP,   'Admin group must be dissolved (tabs redistributed)');

// Admin-gated tabs (the tabs creators/builders/domain_admins never see).
const ADMIN_ONLY_LABELS = TAB_GROUPS
  .flatMap((g) => g.tabs)
  .filter((t) => t.minRole === 'admin')
  .map((t) => t.label);

// ---- Group membership -------------------------------------------------------

test('TAB-SET entry group is exactly Home + Cockpit + Tutorials + MCP + About / Licenses', () => {
  assert.deepEqual(
    ENTRY_GROUP.tabs.map((t) => t.label),
    ['Home', 'Cockpit', 'Tutorials', 'MCP', 'About / Licenses'],
  );
});

test('TAB-SET Plan group is Strategy, Big Bets, Operating Manual, Workflows, Marketplace', () => {
  assert.deepEqual(
    PLAN_GROUP.tabs.map((t) => t.label),
    ['Strategy', 'Big Bets', 'Operating Manual', 'Workflows', 'Marketplace'],
  );
});

test('TAB-SET Context group is Knowledge, Files, Data, Connections, Metrics', () => {
  assert.deepEqual(
    CONTEXT_GROUP.tabs.map((t) => t.label),
    ['Knowledge', 'Files', 'Data', 'Connections', 'Metrics'],
  );
});

test('TAB-SET Build group is Agents, Software, Science, Dashboards, Console', () => {
  assert.deepEqual(
    BUILD_GROUP.tabs.map((t) => t.label),
    ['Agents', 'Software', 'Science', 'Dashboards', 'Console'],
  );
});

test('TAB-SET Govern group is Policies & Approvals, Monitoring, Components, LLM Gateway, Admin', () => {
  assert.deepEqual(
    GOVERN_GROUP.tabs.map((t) => t.label),
    ['Policies & Approvals', 'Monitoring', 'Components', 'LLM Gateway', 'Admin'],
  );
});

// ---- Dissolution of former Admin group tabs --------------------------------

test('TAB-SET dissolved tabs are gone from the nav entirely', () => {
  const all = TAB_GROUPS.flatMap((g) => g.tabs);
  for (const label of ['Users', 'Gateway', 'Orchestration', 'Consoles', 'Workbench',
                        'Terminal', 'Query', 'Governance']) {
    assert.ok(!all.some((t) => t.label === label), `removed/renamed tab "${label}" must not be in the nav`);
  }
  for (const href of ['/users', '/gateway', '/orchestration', '/consoles', '/workbench',
                      '/terminal', '/admin-query']) {
    assert.ok(!all.some((t) => t.href === href), `removed route "${href}" must not be in the nav`);
  }
});

// ---- Key tab properties ----------------------------------------------------

test('TAB-SET Console tab has minRole=admin and href=/console', () => {
  const c = BUILD_GROUP.tabs.find((t) => t.label === 'Console');
  assert.ok(c, 'Console tab must exist in Build group');
  assert.equal(c!.minRole, 'admin', 'Console tab must have minRole: admin');
  assert.equal(c!.href, '/console', 'Console tab must link to /console');
});

test('TAB-SET Policies & Approvals tab has minRole=builder and href=/governance', () => {
  const p = GOVERN_GROUP.tabs.find((t) => t.label === 'Policies & Approvals');
  assert.ok(p, 'Policies & Approvals tab must exist in Govern group');
  assert.equal(p!.minRole, 'builder', 'Policies & Approvals must have minRole builder');
  assert.equal(p!.href, '/governance', 'Policies & Approvals route must remain /governance');
});

test('TAB-SET Admin tab is in Govern group (moved from dissolved Admin group)', () => {
  const a = GOVERN_GROUP.tabs.find((t) => t.label === 'Admin');
  assert.ok(a, 'Admin tab must be in the Govern group');
  assert.equal(a!.minRole, 'admin', 'Admin tab must have minRole: admin');
  assert.equal(a!.href, '/platform', 'Admin tab must link to /platform');
});

test('TAB-SET About / Licenses is in the Entry group with no minRole (all roles can see it)', () => {
  const about = ENTRY_GROUP.tabs.find((t) => t.label === 'About / Licenses');
  assert.ok(about, 'About / Licenses must be in the Entry group');
  assert.equal(about!.minRole, undefined, 'About / Licenses must have no minRole (visible to all)');
  assert.equal(about!.href, '/about', 'About / Licenses must link to /about');
});

test('TAB-SET Tutorials is in the entry group with no minRole', () => {
  const tut = ENTRY_GROUP.tabs.find((t) => t.label === 'Tutorials');
  assert.ok(tut, 'Tutorials must be in the entry group');
  assert.equal(tut!.minRole, undefined, 'Tutorials must have no minRole');
});

test('TAB-SET Marketplace is in the Plan group; MCP is in the entry group', () => {
  assert.ok(PLAN_GROUP.tabs.some((t) => t.label === 'Marketplace'), 'Marketplace under Plan');
  assert.ok(ENTRY_GROUP.tabs.some((t) => t.label === 'MCP'), 'MCP in the entry group');
  assert.ok(!ENTRY_GROUP.tabs.some((t) => t.label === 'Marketplace'), 'Marketplace no longer at the top');
});

// ---- Visibility checks ------------------------------------------------------

test('TAB-VIS creator: sees no admin-only tabs at all', () => {
  const labels = visibleLabels('creator');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `creator must not see admin-only tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'creator must still see Tutorials');
  assert.ok(labels.includes('About / Licenses'), 'creator must see About / Licenses (no minRole)');
  assert.ok(!labels.includes('Monitoring'), 'creator must not see Monitoring (builder+)');
  assert.ok(!labels.includes('LLM Gateway'), 'creator must not see LLM Gateway (builder+)');
  assert.ok(!labels.includes('MCP'), 'creator must not see the MCP setup tab (builder+)');
  assert.ok(!labels.includes('Policies & Approvals'), 'creator must not see Policies & Approvals (builder+)');
});

test('TAB-VIS builder sees the builder-gated tabs (Monitoring, LLM Gateway, MCP, Policies & Approvals) that creators do not', () => {
  const b = visibleLabels('builder');
  const c = visibleLabels('creator');
  for (const l of ['Monitoring', 'LLM Gateway', 'MCP', 'Policies & Approvals']) {
    assert.ok(b.includes(l), `builder must see ${l}`);
    assert.ok(!c.includes(l), `creator must not see ${l}`);
  }
});

test('TAB-VIS creator: Govern group still visible (Monitoring + LLM Gateway are builder+, but group appears for admin-only tabs too — actually Govern is hidden entirely for creator)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'creator');
  const govern = groups.find((g) => g.heading === 'Govern');
  assert.ok(!govern, 'Govern group must be absent for creator (all tabs are builder+ or admin-only)');
});

test('TAB-VIS builder: Govern group is visible and includes Policies & Approvals', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder');
  const govern = groups.find((g) => g.heading === 'Govern');
  assert.ok(govern, 'Govern group must be present for builder');
  assert.ok(govern!.tabs.some((t) => t.label === 'Policies & Approvals'), 'builder must see Policies & Approvals');
  // Admin-only tabs (Console, Components, Admin) remain hidden for builder
  assert.ok(!govern!.tabs.some((t) => t.label === 'Admin'), 'builder must not see Admin tab');
  assert.ok(!govern!.tabs.some((t) => t.label === 'Components'), 'builder must not see Components tab');
});

test('TAB-VIS builder: Console tab in Build group is hidden (admin-only)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder');
  const build = groups.find((g) => g.heading === 'Build');
  assert.ok(build, 'Build group must be present for builder');
  assert.ok(!build!.tabs.some((t) => t.label === 'Console'), 'builder must not see Console (admin-only)');
});

test('TAB-VIS domain_admin: sees no admin-only tabs', () => {
  const labels = visibleLabels('domain_admin');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `domain_admin must not see admin-only tab: ${l}`);
  }
  assert.ok(labels.includes('Tutorials'), 'domain_admin must see Tutorials');
  assert.ok(labels.includes('About / Licenses'), 'domain_admin must see About / Licenses');
  assert.ok(labels.includes('Policies & Approvals'), 'domain_admin must see Policies & Approvals (builder+)');
});

test('TAB-VIS admin: sees all tabs including Console, Admin, Components', () => {
  const labels = visibleLabels('admin');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(labels.includes(l), `admin must see tab: ${l}`);
  }
  assert.ok(labels.includes('Policies & Approvals'), 'admin must see Policies & Approvals');
  assert.ok(labels.includes('Tutorials'), 'admin must see Tutorials');
  assert.ok(labels.includes('About / Licenses'), 'admin must see About / Licenses');
  assert.ok(labels.includes('Console'), 'admin must see Console');
  assert.ok(!labels.includes('Settings'), 'standalone Settings tab must not appear in nav');
  assert.ok(!labels.includes('Terminal'), 'Terminal tab must be gone (merged into Console)');
  assert.ok(!labels.includes('Query'), 'Query tab must be gone (merged into Console)');
  assert.ok(!labels.includes('Governance'), 'Governance label must be gone (renamed to Policies & Approvals)');
});

test('TAB-VIS Policies & Approvals carries minRole=builder (builders approve promotions)', () => {
  const pa = GOVERN_GROUP.tabs.find((t) => t.label === 'Policies & Approvals');
  assert.ok(pa, 'Policies & Approvals tab must exist in the Govern group');
  assert.equal(pa!.minRole, 'builder', 'Policies & Approvals must have minRole builder');
  assert.equal(tabVisible(pa!, 'builder'), true);
  assert.equal(tabVisible(pa!, 'creator'), false);
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

test('TAB-VIS entry/Context/Build/Plan tabs are open to creators except the MCP setup tab and Console', () => {
  // MCP is builder+; Console is admin-only; every other tab in these groups is open to creators.
  const openGroups = [ENTRY_GROUP, CONTEXT_GROUP, BUILD_GROUP, PLAN_GROUP];
  for (const group of openGroups) {
    for (const tab of group.tabs) {
      if (tab.label === 'MCP') {
        assert.equal(tab.minRole, 'builder', 'MCP setup tab is builder-gated');
        continue;
      }
      if (tab.label === 'Console') {
        assert.equal(tab.minRole, 'admin', 'Console operator tab is admin-gated');
        continue;
      }
      assert.equal(tab.minRole, undefined,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" must not have minRole`);
      assert.equal(tabVisible(tab, 'creator'), true,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" hidden from creator`);
    }
  }
});

// ---- 5-tab uniformity -------------------------------------------------------

test('TAB-SET every section has exactly 5 tabs', () => {
  for (const group of TAB_GROUPS) {
    assert.equal(
      group.tabs.length,
      5,
      `group "${group.heading ?? 'Entry'}" must have exactly 5 tabs, got ${group.tabs.length}`,
    );
  }
});
