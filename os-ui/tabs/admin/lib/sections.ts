/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        admin
 * FEATURE:    One Platform menu — the single source of truth for every tenant-administration section
 * USER STORY: As a platform admin I want one place that lists everything I can administer,
 *             so I never have to learn that some controls live in a sidebar entry, others in
 *             a sub-navigation strip, and two of them only appear in one of the two.
 * ARCHITECTURE:
 *   - Data only; no React, no I/O. Rendered by app/(govern)/platform/page.tsx as the one
 *     grouped tile grid. There is deliberately no second navigation.
 *   - There used to be a section strip AND a tile grid; they drifted (13 entries vs 11,
 *     with Roles & Permissions and Components & System reachable only from the strip).
 *     The strip is gone; the sidebar's Platform entry is the way back up.
 *   - `minRole` is advisory for rendering; every /api/platform-admin/* route re-checks it
 *     server-side via adminCtx(), so hiding a tile is never the security boundary.
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
import type { Role } from '@core/kernel/session';

export type AdminGroup = 'Tenant' | 'Models' | 'Infrastructure';

export type AdminSection = {
  /** Stable id (also the nav key). */
  id: string;
  label: string;
  href: string;
  /** One line explaining what the admin does here — shown on the tile. */
  sub: string;
  group: AdminGroup;
  minRole: Role;
};

export const ADMIN_SECTIONS: AdminSection[] = [
  // Tenant
  // Overview will ABSORB Components & System (status, toggle, self-heal) in Task 7 of the
  // 2026-10-30 restructure, becoming "Overview & Health" on one route.
  // It MUST stay minRole: 'builder' — it is the only Platform surface a builder can see, so
  // merging at Components' stricter 'admin' would leave builders an empty Platform tab. The
  // merged surface is builder-READABLE with admin-only ACTIONS.
  { id: 'overview', label: 'Overview', href: '/platform', sub: 'Tenant health at a glance', group: 'Tenant', minRole: 'builder' },
  { id: 'domains', label: 'Domains', href: '/platform/domains', sub: 'Create domains & toggle optional layers', group: 'Tenant', minRole: 'admin' },
  { id: 'settings', label: 'Tenant Settings', href: '/platform/settings', sub: 'SSO, branding, tenant defaults', group: 'Tenant', minRole: 'admin' },
  { id: 'access', label: 'Users & Access', href: '/platform/access', sub: 'Invite, assign domains, offboard', group: 'Tenant', minRole: 'admin' },

  // Models — the LLM control room
  // NO 'gateway' tile. Removed 2026-10-30 at the user's request: the embedded
  // console was unreachable in 0.7.3/0.7.4. Cause found and fixed (the proxy
  // stripped a prefix LiteLLM needs — see Tool.upstreamRootPath), but the fix
  // is unverified in production, so the tile stays out until it is. Restoring
  // it is one entry pointing at /tools/litellm/ui.
  { id: 'models', label: 'Models & Providers', href: '/platform/models', sub: 'Routing defaults, caps, provider keys', group: 'Models', minRole: 'admin' },

  // Infrastructure
  { id: 'backups', label: 'Backups & Restore', href: '/platform/backups', sub: 'Status & guarded restore', group: 'Infrastructure', minRole: 'admin' },
];


/** Tile grid, grouped — every section the viewer's role may reach. */
export const ADMIN_GROUP_ORDER: AdminGroup[] = ['Tenant', 'Models', 'Infrastructure'];
