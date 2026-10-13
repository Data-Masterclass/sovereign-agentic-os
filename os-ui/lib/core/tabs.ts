/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The OS sidebar tab set. The first group is the canonical OS tab order
 * (os-application.md §4); every tab routes to a real surface in v1.0.
 *
 * Six sections (5 tabs each):
 *   Ungrouped (entry): Home, Cockpit, Tutorials, MCP, About / Licenses
 *   Plan:    Strategy, Big Bets, Operating Model, Business Workflows, Marketplace
 *   Context: Knowledge, Files, Data, Connections, Metrics
 *   Build:   Agents, Software, Science, Dashboards, Console (admin)
 *   Govern:  Policies & Approvals (builder+), Monitoring (builder+), Components (admin), LLM Gateway (builder+), Admin (admin)
 *
 * The former Admin group (Admin, Terminal, Query, About / Licenses) was dissolved:
 *   - About / Licenses moved to the Entry group (transparency — every user can read it).
 *   - Admin moved to the Govern group.
 *   - Terminal + Query merged into Console (/console), hosted in the Build group.
 *   - The old /terminal and /admin-query routes were removed (404).
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
  /** Optional-layer gate: the tab only makes sense when the active domain has
   *  this layer enabled (today only 'ml' — the Science layer). Navigation-level
   *  hiding only, exactly like minRole: the page itself stays reachable and the
   *  serving plane reports the layer being off honestly. */
  requiresLayer?: 'ml';
  /** Machine-readable feature key for OS_ENABLED_TABS gating. A tab with no
   *  feature is always visible (role/layer gates still apply). */
  feature?: string;
};

/** The active domain's optional-layer flags, as far as the client knows them.
 *  `null`/`undefined` = unknown (no active domain chosen, or record not found). */
export type LayerFlags = { ml?: boolean } | null | undefined;

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
      { label: 'Home', icon: '◇', href: '/', feature: 'home' },
      { label: 'Cockpit', icon: '◉', href: '/cockpit', feature: 'cockpit' },
      { label: 'Tutorials', icon: '◎', href: '/tutorials', feature: 'tutorials' },
      // MCP setup UI is builder+/admin. Creators still CONNECT via MCP (the
      // /api/mcp endpoint + their per-user token are unaffected) — only this
      // configuration tab is hidden from the creator menu.
      { label: 'MCP', icon: '⌗', href: '/mcp', role: 'Builder / Administrator', minRole: 'builder', feature: 'mcp' },
      { label: 'About / Licenses', icon: '©', href: '/about', feature: 'about' },
    ],
  },
  {
    heading: 'Plan',
    tabs: [
      { label: 'Strategy', icon: '▲', href: '/strategy', feature: 'strategy' },
      { label: 'Big Bets', icon: '◆', href: '/big-bets', feature: 'big-bets' },
      { label: 'Operating Model', icon: '❧', href: '/operating-manual', feature: 'operating-model' },
      { label: 'Business Workflows', icon: '⧉', href: '/workflows', feature: 'workflows' },
      { label: 'Marketplace', icon: '⊞', href: '/marketplace', role: 'Builder / Administrator', feature: 'marketplace' },
    ],
  },
  {
    heading: 'Context',
    tabs: [
      { label: 'Data', icon: '▤', href: '/data', feature: 'data' },
      { label: 'Metrics', icon: '∑', href: '/metrics', feature: 'metrics' },
      { label: 'Files', icon: '❏', href: '/unstructured', feature: 'files' },
      { label: 'Knowledge', icon: '❦', href: '/knowledge', feature: 'knowledge' },
      { label: 'Connections', icon: '⇄', href: '/connections', feature: 'connections' },
    ],
  },
  {
    heading: 'Build',
    tabs: [
      { label: 'Agents', icon: '✦', href: '/agents', feature: 'agents' },
      { label: 'Dashboards', icon: '▦', href: '/dashboards', feature: 'dashboards' },
      { label: 'Software', icon: '⌘', href: '/software', feature: 'software' },
      // Science only exists where the domain's optional Science layer (layers.ml,
      // toggled in Admin → Domains) is on — hidden from the nav when it is
      // explicitly off for the active domain (see tabVisible).
      { label: 'Science', icon: '∿', href: '/science', requiresLayer: 'ml', feature: 'science' },
      // Console merges the former Terminal (/terminal) and Query (/admin-query)
      // operator tools into one page with a Shell | Query switch. The tab is
      // builder-visible so course participants get the GOVERNED Query surface
      // (SQL over Trino/Cube, OPA/RLS-checked per-caller, audited). The raw
      // Shell sub-panel INSIDE it stays admin-only (ConsoleClient gates it) —
      // exposing the tab does NOT expose arbitrary command execution.
      { label: 'Console', icon: '▶', href: '/console', role: 'Builder / Administrator', minRole: 'builder', feature: 'console' },
    ],
  },
  {
    // Renamed Monitor → Govern. Tabs: relabelled Governance → Policies & Approvals
    // (route /governance unchanged), plus Admin moved from the dissolved Admin group.
    heading: 'Govern',
    tabs: [
      { label: 'Policies & Approvals', icon: '⚖', href: '/governance', role: 'Builder / Administrator', minRole: 'builder', feature: 'governance' },
      { label: 'Monitoring', icon: '◷', href: '/monitoring', role: 'Builder / Administrator', minRole: 'builder', feature: 'monitoring' },
      { label: 'Components', icon: '▥', href: '/components', role: 'Administrator', minRole: 'admin', feature: 'components' },
      { label: 'LLM Gateway', icon: '⌁', href: '/llm-gateway', role: 'Builder / Administrator', minRole: 'builder', feature: 'llm-gateway' },
      // Admin (Platform) is builder-visible, but the page renders ONLY the tiles
      // a builder is authorised for (fail-closed per-tile minRole). Every
      // platform-admin tile stays admin-only, and each /platform sub-page's API
      // is hard-gated by adminCtx()/requireAdmin — a builder sees only the
      // self-service Settings tile and never reaches an admin control.
      { label: 'Admin', icon: '❖', href: '/platform', role: 'Builder / Administrator', minRole: 'builder', feature: 'admin' },
    ],
  },
];

/** Tab `feature` keys enabled when OS_ENABLED_TABS is unset/empty: the base tier. */
export const BASE_FEATURES: readonly string[] = [
  'home',
  'about',
  'agents',
  'monitoring',
  'llm-gateway',
  'mcp',
  'governance',
  'tutorials',
  'admin',
  'components',
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
 * Pure visibility check: can `userRole` see `tab` in the active domain?
 * No `minRole` on the tab means visible to everyone.
 * A `null`/`undefined` userRole (unauthenticated) always passes — the Edge
 * middleware handles the redirect to /signin before the page renders.
 *
 * `layers` are the ACTIVE domain's optional-layer flags. A layer-gated tab is
 * hidden ONLY when the layer is EXPLICITLY disabled (`false`); unknown/absent
 * layers FAIL OPEN and the tab stays visible — navigation must never lock a
 * user out on missing data, and the serving plane already 404s honestly when
 * the layer really is off.
 */
export function tabVisible(
  tab: Tab,
  userRole: Role | null | undefined,
  layers?: LayerFlags,
  enabledFeatures: ReadonlySet<string> = new Set(BASE_FEATURES),
): boolean {
  if (tab.feature && !enabledFeatures.has(tab.feature)) return false;
  if (tab.requiresLayer && layers?.[tab.requiresLayer] === false) return false;
  if (!tab.minRole) return true;
  if (!userRole) return true; // middleware guards; UI shows tabs, server redirects
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[tab.minRole] ?? 0);
}

/**
 * Filter tab groups for a given user role + active-domain layers. Empty groups
 * (all tabs hidden) are dropped so no dangling heading appears in the sidebar.
 */
export function filterTabGroups(
  groups: TabGroup[],
  userRole: Role | null | undefined,
  layers?: LayerFlags,
  enabledFeatures: ReadonlySet<string> = new Set(BASE_FEATURES),
): TabGroup[] {
  return groups
    .map((g) => ({ ...g, tabs: g.tabs.filter((t) => tabVisible(t, userRole, layers, enabledFeatures)) }))
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
