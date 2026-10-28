/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tab visibility gate tests for the consolidated nav. The five-section matrix
 * (5 tabs each):
 *   Ungrouped (entry): Home, MCP (builder+), About / Licenses
 *   Plan:    Operating Model
 *   Context: Knowledge, Files, Data, Connections, Metrics
 *   Build:   Agents, Software, Dashboards, Console (admin)
 *   Govern:  Governance (builder+), Monitoring (builder+),
 *            Components (admin), LLM Gateway (builder+), Admin (admin)
 *
 * The former Admin group was dissolved: Admin moved to Govern, Terminal+Query
 * merged into Console (Build group), About/Licenses moved to Entry.
 * Monitor was renamed Govern. Governance tab was relabelled Governance
 * (route /governance unchanged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_GROUPS, BASE_FEATURES, ALL_FEATURES as ALL_FEATURE_KEYS, parseEnabledTabs, enabledTabsWarnings,
  findDisabledTab, tabVisible, filterTabGroups,
} from './tabs.ts';
import type { Role } from './session.ts';

// Flat label list for a given role after filtering.
function visibleLabels(role: Role): string[] {
  return filterTabGroups(TAB_GROUPS, role, ALL_FEATURES).flatMap((g) => g.tabs.map((t) => t.label));
}

const ENTRY_GROUP   = TAB_GROUPS.find((g) => !g.heading)!;
const PLAN_GROUP    = TAB_GROUPS.find((g) => g.heading === 'Plan')!;
const CONTEXT_GROUP = TAB_GROUPS.find((g) => g.heading === 'Context')!;
const BUILD_GROUP   = TAB_GROUPS.find((g) => g.heading === 'Build')!;
const GOVERN_GROUP  = TAB_GROUPS.find((g) => g.heading === 'Manage')!;

assert.ok(ENTRY_GROUP,   'Entry group (no heading) must exist in TAB_GROUPS');
assert.ok(PLAN_GROUP,    'Plan group must exist in TAB_GROUPS');
assert.ok(CONTEXT_GROUP, 'Context group must exist in TAB_GROUPS');
assert.ok(BUILD_GROUP,   'Build group must exist in TAB_GROUPS');
assert.ok(GOVERN_GROUP,  'Manage group must exist in TAB_GROUPS');
// TAB-VIS tests below predate OS_ENABLED_TABS and check role
// gating in isolation — they assume every tab is reachable (a full deployment).
// Pass this explicit "everything enabled" set so the base default doesn't
// change what they're testing. TAB-FEATURE tests further down exercise the
// feature gate itself, using the real default.
const ALL_FEATURES = ALL_FEATURE_KEYS;
const DEFAULT_FEATURES = new Set(BASE_FEATURES);

// The former Monitor and Admin groups must be gone.
const MONITOR_GROUP = TAB_GROUPS.find((g) => g.heading === 'Monitor');
const ADMIN_GROUP   = TAB_GROUPS.find((g) => g.heading === 'Admin');

assert.ok(!MONITOR_GROUP, 'Monitor group must be dissolved (renamed to Manage)');
assert.ok(!ADMIN_GROUP,   'Admin group must be dissolved (tabs redistributed)');

// Admin-gated tabs (the tabs creators/builders/domain_admins never see).
const ADMIN_ONLY_LABELS = TAB_GROUPS
  .flatMap((g) => g.tabs)
  .filter((t) => t.minRole === 'admin')
  .map((t) => t.label);

// ---- Group membership -------------------------------------------------------

test('TAB-SET entry group is exactly Home + MCP + About / Licenses', () => {
  assert.deepEqual(
    ENTRY_GROUP.tabs.map((t) => t.label),
    ['Home', 'MCP', 'About / Licenses'],
  );
});

test('TAB-SET Plan group is Operating Model', () => {
  assert.deepEqual(
    PLAN_GROUP.tabs.map((t) => t.label),
    ['Operating Model'],
  );
});

test('TAB-SET Context group is Data, Metrics, Files, Knowledge (usage order)', () => {
  assert.deepEqual(
    CONTEXT_GROUP.tabs.map((t) => t.label),
    ['Data', 'Metrics', 'Files', 'Knowledge'],
  );
});

test('TAB-SET Build group is Workflows, Agents, Dashboards, Software, Console', () => {
  assert.deepEqual(
    BUILD_GROUP.tabs.map((t) => t.label),
    ['Workflows', 'Agents', 'Dashboards', 'Software', 'Console'],
  );
});

test('TAB-SET Manage group is Connections, Governance, Monitoring, Components, LLM Gateway, Admin', () => {
  assert.deepEqual(
    GOVERN_GROUP.tabs.map((t) => t.label),
    ['Connections', 'Governance', 'Monitoring', 'Components', 'LLM Gateway', 'Admin'],
  );
});

// ---- Dissolution of former Admin group tabs --------------------------------

test('TAB-SET dissolved tabs are gone from the nav entirely', () => {
  const all = TAB_GROUPS.flatMap((g) => g.tabs);
  for (const label of ['Users', 'Gateway', 'Orchestration', 'Consoles', 'Workbench',
                        'Terminal', 'Query', 'Policies & Approvals']) {
    assert.ok(!all.some((t) => t.label === label), `removed/renamed tab "${label}" must not be in the nav`);
  }
  for (const href of ['/users', '/gateway', '/orchestration', '/consoles', '/workbench',
                      '/terminal', '/admin-query']) {
    assert.ok(!all.some((t) => t.href === href), `removed route "${href}" must not be in the nav`);
  }
});

// ---- Key tab properties ----------------------------------------------------

test('TAB-SET Console tab has minRole=builder and href=/console', () => {
  const c = BUILD_GROUP.tabs.find((t) => t.label === 'Console');
  assert.ok(c, 'Console tab must exist in Build group');
  // Console is builder-visible for the governed Query surface; the raw Shell
  // sub-panel inside it stays admin-only (gated in ConsoleClient + the broker).
  assert.equal(c!.minRole, 'builder', 'Console tab must have minRole: builder');
  assert.equal(c!.href, '/console', 'Console tab must link to /console');
});

test('TAB-SET Governance tab has minRole=builder and href=/governance', () => {
  const p = GOVERN_GROUP.tabs.find((t) => t.label === 'Governance');
  assert.ok(p, 'Governance tab must exist in Manage group');
  assert.equal(p!.minRole, 'builder', 'Governance must have minRole builder');
  assert.equal(p!.href, '/governance', 'Governance route must remain /governance');
});

test('TAB-SET Admin tab is in Manage group (moved from dissolved Admin group)', () => {
  const a = GOVERN_GROUP.tabs.find((t) => t.label === 'Admin');
  assert.ok(a, 'Admin tab must be in the Manage group');
  // Admin is builder-visible; the /platform overview renders only the tiles a
  // builder is authorised for (fail-closed) and every sub-page stays admin-only.
  assert.equal(a!.minRole, 'builder', 'Admin tab must have minRole: builder');
  assert.equal(a!.href, '/platform', 'Admin tab must link to /platform');
});

test('TAB-SET About / Licenses is in the Entry group with no minRole (all roles can see it)', () => {
  const about = ENTRY_GROUP.tabs.find((t) => t.label === 'About / Licenses');
  assert.ok(about, 'About / Licenses must be in the Entry group');
  assert.equal(about!.minRole, undefined, 'About / Licenses must have no minRole (visible to all)');
  assert.equal(about!.href, '/about', 'About / Licenses must link to /about');
});

test('TAB-SET MCP is in the entry group', () => {
  assert.ok(ENTRY_GROUP.tabs.some((t) => t.label === 'MCP'), 'MCP in the entry group');
});

// ---- Visibility checks ------------------------------------------------------

test('TAB-VIS creator: sees no admin-only tabs at all', () => {
  const labels = visibleLabels('creator');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `creator must not see admin-only tab: ${l}`);
  }
  assert.ok(labels.includes('About / Licenses'), 'creator must see About / Licenses (no minRole)');
  assert.ok(!labels.includes('Monitoring'), 'creator must not see Monitoring (builder+)');
  assert.ok(!labels.includes('LLM Gateway'), 'creator must not see LLM Gateway (builder+)');
  assert.ok(!labels.includes('MCP'), 'creator must not see the MCP setup tab (builder+)');
  assert.ok(!labels.includes('Policies & Approvals'), 'Policies & Approvals label must be gone (renamed back to Governance)');
});

test('TAB-VIS builder sees the builder-gated tabs (Monitoring, LLM Gateway, MCP, Governance) that creators do not', () => {
  const b = visibleLabels('builder');
  const c = visibleLabels('creator');
  for (const l of ['Monitoring', 'LLM Gateway', 'MCP', 'Governance']) {
    assert.ok(b.includes(l), `builder must see ${l}`);
    assert.ok(!c.includes(l), `creator must not see ${l}`);
  }
});

test('TAB-VIS creator: Manage group shows only the ungated tab (Connections)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'creator', ALL_FEATURES);
  const manage = groups.find((g) => g.heading === 'Manage');
  assert.ok(manage, 'Manage group must be present for creator (Connections is ungated)');
  assert.deepEqual(manage!.tabs.map((t) => t.label), ['Connections'],
    'creator sees only the ungated Manage tabs — Governance/Monitoring/LLM Gateway/Admin are builder+, Components admin');
});

test('TAB-VIS builder: Manage group is visible and includes Governance', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder', ALL_FEATURES);
  const govern = groups.find((g) => g.heading === 'Manage');
  assert.ok(govern, 'Manage group must be present for builder');
  assert.ok(govern!.tabs.some((t) => t.label === 'Governance'), 'builder must see Governance');
  // Admin tab is now builder-visible (tile-filtered overview); Components stays admin-only.
  assert.ok(govern!.tabs.some((t) => t.label === 'Admin'), 'builder must see the Admin tab (tile-filtered)');
  assert.ok(!govern!.tabs.some((t) => t.label === 'Components'), 'builder must not see Components tab');
});

test('TAB-VIS builder: Console tab in Build group is visible (governed Query surface)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'builder', ALL_FEATURES);
  const build = groups.find((g) => g.heading === 'Build');
  assert.ok(build, 'Build group must be present for builder');
  assert.ok(build!.tabs.some((t) => t.label === 'Console'), 'builder must see Console (Query is builder+; the raw Shell inside stays admin-only)');
});

test('TAB-VIS creator: Console tab is still hidden (builder+)', () => {
  const groups = filterTabGroups(TAB_GROUPS, 'creator', ALL_FEATURES);
  const build = groups.find((g) => g.heading === 'Build');
  assert.ok(!build!.tabs.some((t) => t.label === 'Console'), 'creator must not see Console (builder+)');
});

test('TAB-VIS domain_admin: sees no admin-only tabs', () => {
  const labels = visibleLabels('domain_admin');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(!labels.includes(l), `domain_admin must not see admin-only tab: ${l}`);
  }
  assert.ok(labels.includes('About / Licenses'), 'domain_admin must see About / Licenses');
  assert.ok(labels.includes('Governance'), 'domain_admin must see Governance (builder+)');
});

test('TAB-VIS admin: sees all tabs including Console, Admin, Components', () => {
  const labels = visibleLabels('admin');
  for (const l of ADMIN_ONLY_LABELS) {
    assert.ok(labels.includes(l), `admin must see tab: ${l}`);
  }
  assert.ok(labels.includes('Governance'), 'admin must see Governance');
  assert.ok(labels.includes('About / Licenses'), 'admin must see About / Licenses');
  assert.ok(labels.includes('Console'), 'admin must see Console');
  assert.ok(!labels.includes('Settings'), 'standalone Settings tab must not appear in nav');
  assert.ok(!labels.includes('Terminal'), 'Terminal tab must be gone (merged into Console)');
  assert.ok(!labels.includes('Query'), 'Query tab must be gone (merged into Console)');
  assert.ok(!labels.includes('Policies & Approvals'), 'Policies & Approvals label must be gone (renamed back to Governance)');
});

test('TAB-VIS Governance carries minRole=builder (builders approve promotions)', () => {
  const pa = GOVERN_GROUP.tabs.find((t) => t.label === 'Governance');
  assert.ok(pa, 'Governance tab must exist in the Manage group');
  assert.equal(pa!.minRole, 'builder', 'Governance must have minRole builder');
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
  // MCP + Console are builder+; every other tab in these groups is open to creators.
  const openGroups = [ENTRY_GROUP, CONTEXT_GROUP, BUILD_GROUP, PLAN_GROUP];
  for (const group of openGroups) {
    for (const tab of group.tabs) {
      if (tab.label === 'MCP') {
        assert.equal(tab.minRole, 'builder', 'MCP setup tab is builder-gated');
        continue;
      }
      if (tab.label === 'Console') {
        assert.equal(tab.minRole, 'builder', 'Console tab is builder-gated (Query is builder+; Shell inside stays admin-only)');
        continue;
      }
      assert.equal(tab.minRole, undefined,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" must not have minRole`);
      assert.equal(tabVisible(tab, 'creator', ALL_FEATURES), true,
        `${group.heading ?? 'Entry'} group tab "${tab.label}" hidden from creator`);
    }
  }
});

// ---- 5-tab uniformity -------------------------------------------------------

test('TAB-SET section sizes are fixed (Entry 3, Plan 1, Context 4, Build 5, Manage 6)', () => {
  const sizes = Object.fromEntries(TAB_GROUPS.map((g) => [g.heading ?? 'Entry', g.tabs.length]));
  assert.deepEqual(sizes, { Entry: 3, Plan: 1, Context: 4, Build: 5, Manage: 6 });
});

// ---- Feature gating (OS_ENABLED_TABS) ---------------------------------------

test('TAB-FEATURE every tab has a feature key', () => {
  for (const group of TAB_GROUPS) {
    for (const tab of group.tabs) {
      assert.equal(typeof tab.feature, 'string', `${group.heading ?? 'Entry'} tab "${tab.label}" must have a feature key`);
      assert.ok(/^[a-z][a-z0-9-]*$/.test(tab.feature!), `feature key "${tab.feature}" must be kebab-case`);
    }
  }
});

test('TAB-FEATURE default (OS_ENABLED_TABS unset) is exactly the base tab set', () => {
  const expected = ['home', 'about', 'agents', 'monitoring', 'llm-gateway', 'mcp', 'governance', 'admin', 'components'];
  assert.deepEqual([...parseEnabledTabs(undefined)].sort(), expected.sort());
  assert.deepEqual([...BASE_FEATURES].sort(), expected.sort());
});

test('TAB-FEATURE every base feature maps to a real tab', () => {
  for (const f of BASE_FEATURES) assert.ok(ALL_FEATURES.has(f), `base feature "${f}" has no tab`);
});

test('TAB-FEATURE tabVisible hides a tab whose feature is not enabled, for every role', () => {
  const data = CONTEXT_GROUP.tabs.find((t) => t.label === 'Data')!;
  assert.equal(DEFAULT_FEATURES.has(data.feature!), false, 'this test assumes "data" is not in the default base set');
  for (const role of ['creator', 'builder', 'domain_admin', 'admin', null, undefined] as (Role | null | undefined)[]) {
    assert.equal(tabVisible(data, role), false, `${role} must not see Data when its feature is disabled`);
    assert.equal(tabVisible(data, role, new Set(['data'])), true, `${role} sees Data once enabled`);
  }
});

test('TAB-FEATURE tabVisible shows a tab whose feature is enabled (no other gate)', () => {
  const home = ENTRY_GROUP.tabs.find((t) => t.label === 'Home')!;
  assert.equal(tabVisible(home, 'creator'), true);
});

test('TAB-FEATURE combines with role gating: MCP feature enabled but still hidden from creator', () => {
  const mcp = ENTRY_GROUP.tabs.find((t) => t.label === 'MCP')!;
  assert.equal(tabVisible(mcp, 'creator'), false, 'creator still gated by minRole even though feature is enabled');
  assert.equal(tabVisible(mcp, 'builder'), true);
});

test('TAB-FEATURE filterTabGroups: with the default set, admin sees only base-feature tabs', () => {
  const tabs = filterTabGroups(TAB_GROUPS, 'admin').flatMap((g) => g.tabs);
  assert.ok(tabs.length > 0);
  for (const tab of tabs) assert.ok(DEFAULT_FEATURES.has(tab.feature!), `"${tab.label}" visible but not in base set`);
});

test('TAB-FEATURE filterTabGroups: an empty enabled set hides every tab (sidebar loading state)', () => {
  assert.deepEqual(filterTabGroups(TAB_GROUPS, 'admin', new Set()), []);
});

// ---- parseEnabledTabs --------------------------------------------------------

test('TAB-PARSE empty / whitespace / only-commas fall back to the base set', () => {
  for (const raw of [undefined, '', '   ', ' , ,, ']) {
    assert.deepEqual([...parseEnabledTabs(raw)].sort(), [...BASE_FEATURES].sort(), JSON.stringify(raw));
  }
});

test('TAB-PARSE trims, drops empties, and REPLACES (does not extend) the base set', () => {
  assert.deepEqual([...parseEnabledTabs(' home, data ,,metrics ')].sort(), ['data', 'home', 'metrics']);
});

test('TAB-PARSE "*" enables every tab', () => {
  assert.deepEqual([...parseEnabledTabs('*')].sort(), [...ALL_FEATURES].sort());
  assert.deepEqual([...parseEnabledTabs('home, *')].sort(), [...ALL_FEATURES].sort());
});

test('TAB-PARSE keeps unknown keys (so they can be warned about) without enabling any tab', () => {
  const set = parseEnabledTabs('home,admin,bogus');
  assert.ok(set.has('bogus'));
  assert.equal(filterTabGroups(TAB_GROUPS, 'admin', set).flatMap((g) => g.tabs).length, 2);
});

// ---- enabledTabsWarnings -----------------------------------------------------

test('TAB-WARN no warnings for the default and wildcard sets', () => {
  assert.deepEqual(enabledTabsWarnings(parseEnabledTabs(undefined)), []);
  assert.deepEqual(enabledTabsWarnings(parseEnabledTabs('*')), []);
});

test('TAB-WARN flags unknown keys, a missing home, and a missing admin', () => {
  const w = enabledTabsWarnings(parseEnabledTabs('data,datta'));
  assert.equal(w.length, 3);
  assert.ok(w.some((m) => m.includes('datta')));
  assert.ok(w.some((m) => m.includes("'home'")));
  assert.ok(w.some((m) => m.includes("'admin'")));
});

// ---- findDisabledTab (middleware guard) --------------------------------------

test('TAB-GUARD disabled tab route and its sub-routes are reported; enabled/unknown routes are not', () => {
  assert.equal(findDisabledTab('/data', DEFAULT_FEATURES)?.label, 'Data');
  assert.equal(findDisabledTab('/data/sets/1', DEFAULT_FEATURES)?.label, 'Data');
  assert.equal(findDisabledTab('/agents', DEFAULT_FEATURES), undefined);
  assert.equal(findDisabledTab('/agents/x', DEFAULT_FEATURES), undefined);
  assert.equal(findDisabledTab('/does-not-exist', DEFAULT_FEATURES), undefined);
  assert.equal(findDisabledTab('/data', new Set(['data'])), undefined);
});

test('TAB-GUARD prefix match is segment-aware (/dataset is not /data)', () => {
  assert.equal(findDisabledTab('/database', DEFAULT_FEATURES), undefined);
});

test('TAB-GUARD "/" matches exactly, only when home is disabled', () => {
  const noHome = new Set(['agents']);
  assert.equal(findDisabledTab('/', noHome)?.label, 'Home');
  assert.equal(findDisabledTab('/agents', noHome), undefined);
  assert.equal(findDisabledTab('/', DEFAULT_FEATURES), undefined);
});
