/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        admin
 * FEATURE:    One Platform route with a tab strip on top — the single source of truth for every
 *             tenant-administration section, and the only navigation the page has
 * USER STORY: As a platform admin I want Platform to work like Governance: one route, tabs across
 *             the top, content switching in place — so I never bounce between a tile grid and six
 *             separate pages to do one job.
 * ARCHITECTURE:
 *   - Data only; no React, no I/O. Rendered by app/(govern)/platform/page.tsx as a `.tabstrip`
 *     plus the active section's component from tabs/admin/ui/. There is ONE navigation system:
 *     the tile grid was removed on 2026-10-30 (it was the second one).
 *   - Every href is `/platform?section=<id>`: one route, deep-linkable. The old `/platform/<id>`
 *     routes still exist as redirects here, so live links and bookmarks keep working.
 *   - `minRole` now gates a TAB, not a route. Collapsing the sections onto one route destroyed the
 *     old pathname gate in platform/layout.tsx (which allowed any non-admin at exactly `/platform`),
 *     so the gate moved INTO the strip: `visibleSections()` and `resolveSection()` below are the
 *     fail-closed filter the page uses, and each admin-only component fails closed again on its own.
 *     Hiding is still never the security boundary — every /api/platform-admin/* route re-checks
 *     server-side via adminCtx().
 *   - Admin was renamed Platform on 2026-10-30 and cut from 16 entries to six. The menu now
 *     holds ONLY tenant administration; everything else moved to the tab that answers the
 *     question the user is actually asking. Where each removed section went:
 *       billing                        → Monitoring (the spend envelope is display-only: observation)
 *       roles + security               → Governance (role definitions and the egress allowlist are policy)
 *       plugins + mcp-apis + oauth-apps → Connections (all three are registries of what the tenant admits)
 *       my-mcp + my-settings + licenses → the sidebar account menu (personal, not administration)
 *       components                     → merged INTO overview (both reported what runs and whether it is healthy)
 *     None of these were deleted; they are owned elsewhere now.
 */
import { roleAtLeast, type Role } from '@core/kernel/session';

export type AdminGroup = 'Tenant' | 'Models' | 'Infrastructure';

export type AdminSection = {
  /** Stable id (also the `?section=` value and the nav key). */
  id: string;
  label: string;
  /** Always `/platform?section=<id>` — one route, six tabs. */
  href: string;
  /** One line explaining what the admin does here. */
  sub: string;
  group: AdminGroup;
  minRole: Role;
};

export const ADMIN_SECTIONS: AdminSection[] = [
  // Tenant
  // Overview ABSORBED Components & System (status, toggle, self-heal) on 2026-10-30; both
  // reported what is running and whether it is healthy.
  // It MUST stay minRole: 'builder' — it is the only Platform surface a builder can see, so
  // merging at Components' stricter 'admin' would leave builders an empty Platform tab. The
  // merged surface is builder-READABLE with admin-only ACTIONS (see OVERVIEW_ACTION_MIN_ROLE).
  { id: 'overview', label: 'Overview & Health', href: '/platform?section=overview', sub: 'Tenant health, components & self-heal', group: 'Tenant', minRole: 'builder' },
  { id: 'domains', label: 'Domains', href: '/platform?section=domains', sub: 'Create domains & toggle optional layers', group: 'Tenant', minRole: 'admin' },
  { id: 'settings', label: 'Tenant Settings', href: '/platform?section=settings', sub: 'SSO, branding, tenant defaults', group: 'Tenant', minRole: 'admin' },
  { id: 'access', label: 'Users & Access', href: '/platform?section=access', sub: 'Invite, assign domains, offboard', group: 'Tenant', minRole: 'admin' },

  // Models — the LLM control room
  // NO 'gateway' tab. Removed 2026-10-30 at the user's request: the embedded
  // console was unreachable in 0.7.3/0.7.4. Cause found and fixed (the proxy
  // stripped a prefix LiteLLM needs — see Tool.upstreamRootPath), but the fix
  // is unverified in production, so the tab stays out until it is. Restoring
  // it is one entry pointing at /tools/litellm/ui.
  { id: 'models', label: 'Models & Providers', href: '/platform?section=models', sub: 'Routing defaults, caps, provider keys', group: 'Models', minRole: 'admin' },

  // Infrastructure
  { id: 'backups', label: 'Backups & Restore', href: '/platform?section=backups', sub: 'Status & guarded restore', group: 'Infrastructure', minRole: 'admin' },
];

/** Tab-strip order — related tabs sit together, groups in this sequence. */
export const ADMIN_GROUP_ORDER: AdminGroup[] = ['Tenant', 'Models', 'Infrastructure'];

/** The section the strip lands on when `?section=` is absent. */
export const DEFAULT_SECTION = 'overview';

/**
 * Overview & Health is builder-READABLE (see its `minRole`), but enabling or
 * disabling a component is administration: the toggles, the guarded confirm and
 * the admin cockpit (KPIs, alerts, audit) require this role. The merge did NOT
 * take the stricter of the two roles — it split read from act.
 */
export const OVERVIEW_ACTION_MIN_ROLE: Role = 'admin';

/**
 * The floor a section's OWN component re-checks before it renders or fetches
 * (defence in depth behind the strip). FAIL-CLOSED: an id this file does not
 * know is treated as admin-only, never as open.
 */
export function sectionMinRole(id: string): Role {
  return ADMIN_SECTIONS.find((s) => s.id === id)?.minRole ?? 'admin';
}

/**
 * The tabs a caller may see, in `ADMIN_GROUP_ORDER` sequence. FAIL-CLOSED:
 * an unresolved role (`null`, i.e. still loading or anonymous) sees NOTHING,
 * and a role below a tab's `minRole` never gets that tab — so admin content
 * cannot flash into a builder's strip while `/api/auth/me` is in flight.
 */
export function visibleSections(role: Role | null): AdminSection[] {
  if (role === null) return [];
  return ADMIN_SECTIONS
    .filter((s) => roleAtLeast(role, s.minRole))
    .sort((a, b) => ADMIN_GROUP_ORDER.indexOf(a.group) - ADMIN_GROUP_ORDER.indexOf(b.group));
}

/**
 * Resolve `?section=` to a section this role may actually render, or `null` for
 * "render nothing". Deep-linking is the whole point of one route, so this is the
 * gate that replaces the old per-route pathname check:
 *   - role unresolved            → null (nothing, never a flash)
 *   - a section the role may see → that section
 *   - a REAL section the role may NOT see (`/platform?section=domains` typed by a
 *     builder) → null. Not a quiet fallback to the overview: the request was for
 *     something they may not have, and the honest answer is nothing.
 *   - absent or unknown id       → the default tab, if the role may see it.
 */
export function resolveSection(param: string | null, role: Role | null): string | null {
  const visible = visibleSections(role);
  if (visible.length === 0) return null;
  if (param && visible.some((s) => s.id === param)) return param;
  if (param && ADMIN_SECTIONS.some((s) => s.id === param)) return null; // real, but not for you
  return visible.some((s) => s.id === DEFAULT_SECTION) ? DEFAULT_SECTION : null;
}
