/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The OS sidebar tab set. The first group is the canonical OS tab order
 * (os-application.md §4); every tab routes to a real surface in v1.0.
 *
 * Six sections:
 *   Ungrouped (entry): Home, Cockpit
 *   Plan:    Strategy, Big Bets, MCP, Tutorials
 *   Context: Knowledge, Files, Data, Connections, Metrics, Marketplace
 *   Build:   Agents, Software, Science, Dashboards
 *   Monitor: Governance (builder+), Monitoring, Components (admin), LLM Gateway
 *   Admin:   Admin (admin), Terminal (admin), Query (admin), About / Licenses (admin)
 *
 * The former Users / Gateway / Orchestration / Consoles / Workbench tabs were
 * consolidated: Users & Access lives in Admin (/platform), and the gateway /
 * orchestrator / console launchers merged into the one Components surface
 * (/components); the old routes redirect.
 */
import type { Role } from '@/lib/session';

export type Tab = {
  label: string;
  icon: string; // single-glyph marker rendered in the sidebar
  href?: string; // present => navigable; absent => stub ("soon")
  role?: string; // human-readable display hint (legacy informational label)
  /** Machine-readable minimum role required to see + reach this tab. */
  minRole?: Role;
};

export type TabGroup = {
  heading?: string;
  tabs: Tab[];
};

export const TAB_GROUPS: TabGroup[] = [
  {
    // Entry points — ungrouped, always at the top
    tabs: [
      { label: 'Home', icon: '◇', href: '/' },
      { label: 'Cockpit', icon: '◉', href: '/cockpit' },
      { label: 'Marketplace', icon: '⊞', href: '/marketplace', role: 'Builder / Administrator' },
    ],
  },
  {
    heading: 'Plan',
    tabs: [
      { label: 'Strategy', icon: '▲', href: '/strategy' },
      { label: 'Big Bets', icon: '◆', href: '/big-bets' },
      // MCP setup UI is builder+/admin. Creators still CONNECT via MCP (the
      // /api/mcp endpoint + their per-user token are unaffected) — only this
      // configuration tab is hidden from the creator menu.
      { label: 'MCP', icon: '⌗', href: '/mcp', role: 'Builder / Administrator', minRole: 'builder' },
      { label: 'Tutorials', icon: '◎', href: '/tutorials' },
    ],
  },
  {
    heading: 'Context',
    tabs: [
      { label: 'Knowledge', icon: '❦', href: '/knowledge' },
      { label: 'Files', icon: '❏', href: '/unstructured' },
      { label: 'Data', icon: '▤', href: '/data' },
      { label: 'Connections', icon: '⇄', href: '/connections' },
      { label: 'Metrics', icon: '∑', href: '/metrics' },
    ],
  },
  {
    heading: 'Build',
    tabs: [
      { label: 'Agents', icon: '✦', href: '/agents' },
      { label: 'Software', icon: '⌘', href: '/software' },
      { label: 'Science', icon: '∿', href: '/science' },
      { label: 'Dashboards', icon: '▦', href: '/dashboards' },
    ],
  },
  {
    heading: 'Monitor',
    tabs: [
      // Governance (approvals / the sharing ladder) is oversight — it lives in Monitor.
      // Builder+ (its own minRole) see it here.
      { label: 'Governance', icon: '⚖', href: '/governance', role: 'Builder / Administrator', minRole: 'builder' },
      { label: 'Monitoring', icon: '◷', href: '/monitoring', role: 'Builder / Administrator', minRole: 'builder' },
      { label: 'Components', icon: '▥', href: '/components', role: 'Administrator', minRole: 'admin' },
      { label: 'LLM Gateway', icon: '⌁', href: '/llm-gateway', role: 'Builder / Administrator', minRole: 'builder' },
    ],
  },
  {
    heading: 'Admin',
    tabs: [
      { label: 'Admin', icon: '❖', href: '/platform', role: 'Administrator', minRole: 'admin' },
      { label: 'Terminal', icon: '▮', href: '/terminal', role: 'Administrator', minRole: 'admin' },
      { label: 'Query', icon: '⌥', href: '/admin-query', role: 'Administrator', minRole: 'admin' },
      { label: 'About / Licenses', icon: '©', href: '/about', role: 'Administrator', minRole: 'admin' },
    ],
  },
];

// Flat list (kept for any consumer that just wants every tab in order).
export const TABS: Tab[] = TAB_GROUPS.flatMap((g) => g.tabs);

/** Role rank — creator(0) < builder(1) < domain_admin(2) < admin(3). */
const ROLE_RANK: Record<Role, number> = { creator: 0, builder: 1, domain_admin: 2, admin: 3 };

/**
 * Pure visibility check: can `userRole` see `tab`?
 * No `minRole` on the tab means visible to everyone.
 * A `null`/`undefined` userRole (unauthenticated) always passes — the Edge
 * middleware handles the redirect to /signin before the page renders.
 */
export function tabVisible(tab: Tab, userRole: Role | null | undefined): boolean {
  if (!tab.minRole) return true;
  if (!userRole) return true; // middleware guards; UI shows tabs, server redirects
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[tab.minRole] ?? 0);
}

/**
 * Filter tab groups for a given user role. Empty groups (all tabs hidden) are
 * dropped so no dangling heading appears in the sidebar.
 */
export function filterTabGroups(groups: TabGroup[], userRole: Role | null | undefined): TabGroup[] {
  return groups
    .map((g) => ({ ...g, tabs: g.tabs.filter((t) => tabVisible(t, userRole)) }))
    .filter((g) => g.tabs.length > 0);
}
