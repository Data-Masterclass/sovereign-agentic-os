/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The OS sidebar tab set — the 13 tabs, in the order the product reads.
 *
 *   Entry:   Home
 *   Context: Data, KPIs, Files, Knowledge          (bring context in)
 *   Build:   Workflows, Agents, Dashboards, Software   (put it to work)
 *   Manage:  Connections, Governance (builder+), Monitoring (builder+), Admin (builder+)
 *
 * ONE admin menu: Components, the LLM Gateway, MCP access and About/Licenses are
 * NOT separate sidebar entries — they are sections of the admin menu defined in
 * tabs/admin/lib/sections.ts, which the ONE /platform tab strip renders (the tile
 * grid was removed 2026-10-30 — two navigations for one page is how they drifted).
 * Their routes still work and are listed there.
 *
 * `feature` keys drive OS_ENABLED_TABS gating; a tab whose key is not enabled is
 * hidden from the nav AND 404s at the route (see findDisabledTab, used by the Edge
 * middleware). `minRole` hides a tab from the nav; the page and its APIs re-check
 * the gate server-side, so hiding is never the security boundary.
 */
import type { Role } from '@core/kernel/session';

export type Tab = {
  label: string;
  icon: string; // single-glyph marker rendered in the sidebar
  href?: string; // present => navigable; absent => stub ("soon")
  role?: string; // human-readable display hint (legacy informational label)
  /** Machine-readable minimum role required to see + reach this tab. */
  minRole?: Role;
  /** Machine-readable feature key for OS_ENABLED_TABS gating. A tab with no
   *  feature is always visible (role gates still apply). */
  feature?: string;
};

export type TabGroup = {
  heading?: string;
  tabs: Tab[];
};

export const TAB_GROUPS: TabGroup[] = [
  {
    // Entry — ungrouped, always at the top. Home is the only one: MCP access and
    // About/Licenses became sections of the one admin menu (tabs/admin/lib/
    // sections.ts), and their routes stay reachable for every role that may use them.
    tabs: [
      { label: 'Home', icon: '◇', href: '/', feature: 'home' },
    ],
  },
  {
    heading: 'Context',
    tabs: [
      { label: 'Data', icon: '▤', href: '/data', feature: 'data' },
      { label: 'KPIs', icon: '∑', href: '/metrics', feature: 'metrics' },
      { label: 'Files', icon: '❏', href: '/unstructured', feature: 'files' },
      { label: 'Knowledge', icon: '❦', href: '/knowledge', feature: 'knowledge' },
    ],
  },
  {
    heading: 'Build',
    tabs: [
      { label: 'Workflows', icon: '⧉', href: '/workflows', feature: 'workflows' },
      { label: 'Agents', icon: '✦', href: '/agents', feature: 'agents' },
      { label: 'Dashboards', icon: '▦', href: '/dashboards', feature: 'dashboards' },
      { label: 'Software', icon: '⌘', href: '/software', feature: 'software' },
    ],
  },
  {
    // Renamed Monitor → Govern → Manage. Connections (from Context) leads the
    // group; the approvals inbox is
    // labelled Governance (route /governance), and Admin moved here from the
    // dissolved Admin group.
    heading: 'Manage',
    tabs: [
      { label: 'Connections', icon: '⇄', href: '/connections', feature: 'connections' },
      { label: 'Governance', icon: '⚖', href: '/governance', role: 'Builder / Administrator', minRole: 'builder', feature: 'governance' },
      { label: 'Monitoring', icon: '◷', href: '/monitoring', role: 'Builder / Administrator', minRole: 'builder', feature: 'monitoring' },
      // Admin (Platform) is builder-visible, but the page renders ONLY the tiles
      // a builder is authorised for (fail-closed per-tile minRole). Every
      // platform-admin tile stays admin-only, and each /platform sub-page's API
      // is hard-gated by adminCtx()/requireAdmin — a builder sees only the
      // self-service Settings tile and never reaches an admin control.
      { label: 'Platform', icon: '❖', href: '/platform', role: 'Builder / Administrator', minRole: 'builder', feature: 'admin' },
    ],
  },
];

/** Tab `feature` keys enabled when OS_ENABLED_TABS is unset/empty: the base tier. */
export const BASE_FEATURES: readonly string[] = [
  'home',
  'agents',
  'monitoring',
  'governance',
  'admin',
];

/** Every feature key declared by a tab in TAB_GROUPS. */
export const ALL_FEATURES: ReadonlySet<string> = new Set(
  TAB_GROUPS.flatMap((g) => g.tabs.flatMap((t) => (t.feature ? [t.feature] : []))),
);

/** Wildcard accepted by OS_ENABLED_TABS: enable every tab. */
export const ALL_TABS_WILDCARD = '*';

/**
 * Parse a raw OS_ENABLED_TABS value into the enabled feature set. Empty/unset →
 * the base tier; `*` → every tab; otherwise the comma-separated keys REPLACE the
 * base tier (they do not extend it). Pure: the caller supplies the env value.
 */
export function parseEnabledTabs(raw: string | undefined): Set<string> {
  const keys = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return new Set(BASE_FEATURES);
  if (keys.includes(ALL_TABS_WILDCARD)) return new Set(ALL_FEATURES);
  return new Set(keys);
}

/** Human-readable misconfiguration warnings for an enabled set (empty = fine). */
export function enabledTabsWarnings(enabled: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const unknown = [...enabled].filter((k) => !ALL_FEATURES.has(k));
  if (unknown.length) {
    out.push(`unknown tab key(s) ignored: ${unknown.join(', ')} (valid: ${[...ALL_FEATURES].join(', ')})`);
  }
  if (!enabled.has('home')) out.push("'home' is not enabled: '/' (the post-login landing page) will 404");
  if (!enabled.has('admin')) out.push("'admin' is not enabled: /platform (the admin UI) will 404");
  return out;
}

/** The enabled feature set for this process (OS_ENABLED_TABS; unset → base tier). */
export const TAB_FEATURES: Set<string> = parseEnabledTabs(process.env.OS_ENABLED_TABS);

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
export function tabVisible(
  tab: Tab,
  userRole: Role | null | undefined,
  enabledFeatures: ReadonlySet<string> = new Set(BASE_FEATURES),
): boolean {
  if (tab.feature && !enabledFeatures.has(tab.feature)) return false;
  if (!tab.minRole) return true;
  if (!userRole) return true; // middleware guards; UI shows tabs, server redirects
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[tab.minRole] ?? 0);
}

/**
 * Filter tab groups for a given user role. Empty groups
 * (all tabs hidden) are dropped so no dangling heading appears in the sidebar.
 */
export function filterTabGroups(
  groups: TabGroup[],
  userRole: Role | null | undefined,
  enabledFeatures: ReadonlySet<string> = new Set(BASE_FEATURES),
): TabGroup[] {
  return groups
    .map((g) => ({ ...g, tabs: g.tabs.filter((t) => tabVisible(t, userRole, enabledFeatures)) }))

    .filter((g) => g.tabs.length > 0);
}

/**
 * The tab whose route (its href, or any sub-route) is requested but whose feature
 * is not enabled — i.e. the route must 404. `/` matches exactly so the home tab
 * does not swallow every path. Pure; used by middleware.
 */
export function findDisabledTab(pathname: string, enabledFeatures: ReadonlySet<string>): Tab | undefined {
  return TABS.find((tab) => {
    if (!tab.href || !tab.feature || enabledFeatures.has(tab.feature)) return false;
    return tab.href === '/' ? pathname === '/' : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
  });
}
