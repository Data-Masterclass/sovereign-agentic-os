/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The OS sidebar tab set. The first group is the canonical OS tab order
 * (os-application.md §4); every tab routes to a real surface in v1.0. The
 * second group ("Platform") holds infrastructure consoles wired to in-cluster
 * services that don't map onto a single business tab (the model/MCP gateway,
 * the orchestrator, the launchpad for the full external tool UIs, and the
 * About / Licenses page).
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
    tabs: [
      { label: 'Home', icon: '◇', href: '/' },
      { label: 'Cockpit', icon: '◉', href: '/cockpit' },
      { label: 'Strategy', icon: '▲', href: '/strategy' },
      { label: 'Big Bets', icon: '◆', href: '/big-bets' },
      { label: 'Agents', icon: '✦', href: '/agents' },
      { label: 'Software', icon: '⌘', href: '/software' },
      { label: 'Science', icon: '∿', href: '/science' },
      { label: 'Knowledge', icon: '❦', href: '/knowledge' },
      { label: 'Files', icon: '❏', href: '/unstructured' },
      { label: 'Data', icon: '▤', href: '/data' },
      { label: 'Metrics', icon: '∑', href: '/metrics' },
      { label: 'Dashboards', icon: '▦', href: '/dashboards' },
      { label: 'Connections', icon: '⇄', href: '/connections' },
      { label: 'Marketplace', icon: '⊞', href: '/marketplace', role: 'Builder / Administrator' },
      { label: 'Monitoring', icon: '◷', href: '/monitoring' },
      { label: 'Governance', icon: '⚖', href: '/governance', role: 'Builder / Administrator' },
      { label: 'Settings', icon: '⚙', href: '/settings' },
    ],
  },
  {
    heading: 'Platform',
    tabs: [
      { label: 'Admin', icon: '❖', href: '/platform', role: 'Administrator', minRole: 'admin' },
      { label: 'Users', icon: '☖', href: '/users', role: 'Administrator', minRole: 'admin' },
      { label: 'Components', icon: '▥', href: '/components', role: 'Administrator', minRole: 'admin' },
      { label: 'Gateway', icon: '⌁', href: '/gateway', role: 'Administrator', minRole: 'admin' },
      { label: 'Orchestration', icon: '⟲', href: '/orchestration', role: 'Administrator', minRole: 'admin' },
      { label: 'Workbench', icon: '⬓', href: '/workbench', role: 'Administrator', minRole: 'admin' },
      { label: 'Terminal', icon: '▮', href: '/terminal', role: 'Administrator', minRole: 'admin' },
      { label: 'Tutorials', icon: '◎', href: '/tutorials' },
      { label: 'Consoles', icon: '◫', href: '/consoles', role: 'Administrator', minRole: 'admin' },
      { label: 'About / Licenses', icon: '©', href: '/about', role: 'Administrator', minRole: 'admin' },
    ],
  },
];

// Flat list (kept for any consumer that just wants every tab in order).
export const TABS: Tab[] = TAB_GROUPS.flatMap((g) => g.tabs);

/** Role rank — creator(0) < builder(1) < admin(2). */
const ROLE_RANK: Record<Role, number> = { creator: 0, builder: 1, admin: 2 };

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
