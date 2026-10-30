/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        admin
 * FEATURE:    One admin menu — the single source of truth for every platform section
 * USER STORY: As a platform admin I want one place that lists everything I can administer,
 *             so I never have to learn that some controls live in a sidebar entry, others in
 *             a sub-navigation strip, and two of them only appear in one of the two.
 * ARCHITECTURE:
 *   - Data only; no React, no I/O. Rendered by app/(govern)/platform/page.tsx as the one
 *     grouped tile grid. There is deliberately no second navigation.
 *   - There used to be a section strip AND a tile grid; they drifted (13 entries vs 11,
 *     with Roles & Permissions and Components & System reachable only from the strip).
 *     The strip is gone; the sidebar's Admin entry is the way back up.
 *   - `minRole` is advisory for rendering; every /api/platform-admin/* route re-checks it
 *     server-side via adminCtx(), so hiding a tile is never the security boundary.
 */
import type { Role } from '@core/kernel/session';

export type AdminGroup = 'Tenant' | 'People' | 'Models & cost' | 'Platform' | 'Me';

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
  { id: 'overview', label: 'Overview', href: '/platform', sub: 'Tenant health at a glance', group: 'Tenant', minRole: 'builder' },

  // People
  { id: 'access', label: 'Users & Access', href: '/platform/access', sub: 'Invite, assign domains, offboard', group: 'People', minRole: 'admin' },
  { id: 'roles', label: 'Roles & Permissions', href: '/platform/roles', sub: 'What each role may do, per component', group: 'People', minRole: 'admin' },
  { id: 'domains', label: 'Domains', href: '/platform/domains', sub: 'Create domains & toggle optional layers', group: 'Tenant', minRole: 'admin' },

  // Models & cost — the LLM control room
  { id: 'models', label: 'Models & Providers', href: '/platform/models', sub: 'Routing defaults, caps, provider keys', group: 'Models & cost', minRole: 'admin' },
  // `/ui` NOT `/` — LiteLLM's root serves its FastAPI Swagger page, whose assets
  // are root-absolute and blocked behind the proxy prefix, so the tab rendered
  // blank with the title "API - Swagger UI". The admin console lives at `/ui`
  // under SERVER_ROOT_PATH (set to /tools/litellm in the chart).
  { id: 'gateway', label: 'LLM Gateway', href: '/tools/litellm/ui', sub: 'Models, keys, budgets and guardrails — in LiteLLM', group: 'Models & cost', minRole: 'admin' },
  { id: 'billing', label: 'Cost & Billing', href: '/platform/billing', sub: 'Spend envelope & premium cap', group: 'Models & cost', minRole: 'admin' },

  // Platform
  { id: 'components', label: 'Components & System', href: '/platform/components', sub: 'Every workload: status, toggle, self-heal', group: 'Platform', minRole: 'admin' },
  { id: 'mcp-apis', label: 'MCPs & APIs', href: '/platform/mcp-apis', sub: 'Registered MCP servers & API keys', group: 'Platform', minRole: 'admin' },
  { id: 'plugins', label: 'Plugins', href: '/platform/plugins', sub: 'Curate & install MCPs / skills', group: 'Platform', minRole: 'admin' },
  { id: 'oauth-apps', label: 'Drive OAuth apps', href: '/platform/oauth-apps', sub: 'Google & Microsoft apps for connected drives', group: 'Platform', minRole: 'admin' },
  { id: 'security', label: 'Security & Egress', href: '/platform/security', sub: 'Allowlist, OPA bundle, residency', group: 'Platform', minRole: 'admin' },
  { id: 'backups', label: 'Backups & Restore', href: '/platform/backups', sub: 'Status & guarded restore', group: 'Platform', minRole: 'admin' },
  { id: 'settings', label: 'Tenant Settings', href: '/platform/settings', sub: 'SSO, branding, tenant defaults', group: 'Tenant', minRole: 'admin' },

  // Me — self-service, the one builder-visible section
  { id: 'my-mcp', label: 'My MCP access', href: '/mcp', sub: 'Mint your MCP token; see your tools', group: 'Me', minRole: 'builder' },
  { id: 'my-settings', label: 'My Settings', href: '/settings', sub: 'Theme & deployment info', group: 'Me', minRole: 'builder' },
  { id: 'licenses', label: 'About / Licenses', href: '/about', sub: 'Bundled open source, by licence', group: 'Me', minRole: 'creator' },
];


/** Tile grid, grouped — every section the viewer's role may reach. */
export const ADMIN_GROUP_ORDER: AdminGroup[] = ['Tenant', 'People', 'Models & cost', 'Platform', 'Me'];
