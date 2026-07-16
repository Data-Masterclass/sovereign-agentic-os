/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The OS sidebar tab set. The first group is the canonical OS tab order
 * (os-application.md §4); every tab routes to a real surface in v1.0.
 *
 * Six sections (5 tabs each):
 *   Ungrouped (entry): Home, Cockpit, Tutorials, MCP, About / Licenses
 *   Plan:    Strategy, Big Bets, Operating Model, Workflows, Marketplace
 *   Context: Knowledge, Files, Data, Connections, Metrics
 *   Build:   Agents, Software, Science, Dashboards, Console (admin)
 *   Govern:  Policies & Approvals (builder+), Monitoring (builder+), Components (admin), LLM Gateway (builder+), Admin (admin)
 *
 * The former Admin group (Admin, Terminal, Query, About / Licenses) was dissolved:
 *   - About / Licenses moved to the Entry group (transparency — every user can read it).
 *   - Admin moved to the Govern group.
 *   - Terminal + Query merged into Console (/console), hosted in the Build group.
 *   - Old /terminal and /admin-query routes redirect to /console.
 *
 * The former Monitor group was renamed Govern. The Governance tab was relabelled
 * "Policies & Approvals" (route unchanged: /governance).
 *
 * The former Users / Gateway / Orchestration / Consoles / Workbench tabs were
 * consolidated: Users & Access lives in Admin (/platform), and the gateway /
 * orchestrator / console launchers merged into the one Components surface
 * (/components); the old routes redirect.
 */
import type { Role } from '@/lib/core/session';

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
    // Entry points — ungrouped, always at the top. About / Licenses lives here for
    // transparency (every role can read it); the admin gate on the page itself was
    // the only real constraint — moving it here keeps it accessible and honest.
    tabs: [
      { label: 'Home', icon: '◇', href: '/' },
      { label: 'Cockpit', icon: '◉', href: '/cockpit' },
      { label: 'Tutorials', icon: '◎', href: '/tutorials' },
      // MCP setup UI is builder+/admin. Creators still CONNECT via MCP (the
      // /api/mcp endpoint + their per-user token are unaffected) — only this
      // configuration tab is hidden from the creator menu.
      { label: 'MCP', icon: '⌗', href: '/mcp', role: 'Builder / Administrator', minRole: 'builder' },
      { label: 'About / Licenses', icon: '©', href: '/about' },
    ],
  },
  {
    heading: 'Plan',
    tabs: [
      { label: 'Strategy', icon: '▲', href: '/strategy' },
      { label: 'Big Bets', icon: '◆', href: '/big-bets' },
      { label: 'Operating Model', icon: '❧', href: '/operating-manual' },
      { label: 'Workflows', icon: '⧉', href: '/workflows' },
      { label: 'Marketplace', icon: '⊞', href: '/marketplace', role: 'Builder / Administrator' },
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
      // Console merges the former Terminal (/terminal) and Query (/admin-query)
      // operator tools into one page with a Shell | Query switch. The tab is
      // builder-visible so course participants get the GOVERNED Query surface
      // (SQL over Trino/Cube, OPA/RLS-checked per-caller, audited). The raw
      // Shell sub-panel INSIDE it stays admin-only (ConsoleClient gates it) —
      // exposing the tab does NOT expose arbitrary command execution.
      { label: 'Console', icon: '▶', href: '/console', role: 'Builder / Administrator', minRole: 'builder' },
    ],
  },
  {
    // Renamed Monitor → Govern. Tabs: relabelled Governance → Policies & Approvals
    // (route /governance unchanged), plus Admin moved from the dissolved Admin group.
    heading: 'Govern',
    tabs: [
      { label: 'Policies & Approvals', icon: '⚖', href: '/governance', role: 'Builder / Administrator', minRole: 'builder' },
      { label: 'Monitoring', icon: '◷', href: '/monitoring', role: 'Builder / Administrator', minRole: 'builder' },
      { label: 'Components', icon: '▥', href: '/components', role: 'Administrator', minRole: 'admin' },
      { label: 'LLM Gateway', icon: '⌁', href: '/llm-gateway', role: 'Builder / Administrator', minRole: 'builder' },
      // Admin (Platform) is builder-visible, but the page renders ONLY the tiles
      // a builder is authorised for (fail-closed per-tile minRole). Every
      // platform-admin tile stays admin-only, and each /platform sub-page's API
      // is hard-gated by adminCtx()/requireAdmin — a builder sees only the
      // self-service Settings tile and never reaches an admin control.
      { label: 'Admin', icon: '❖', href: '/platform', role: 'Builder / Administrator', minRole: 'builder' },
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
