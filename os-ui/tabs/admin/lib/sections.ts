/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        admin
 * FEATURE:    One admin menu — the single source of truth for every platform section
 * USER STORY: As a platform admin I want one place that lists everything I can administer,
 *             so I never have to learn that some controls live in a sidebar entry, others in
 *             a sub-navigation strip, and two of them only appear in one of the two.
 * ARCHITECTURE:
 *   - Data only; no React, no I/O. Rendered by tabs/admin/ui/PlatformNav.tsx (the strip) and
 *     app/(govern)/platform/page.tsx (the tile grid) so the two can no longer disagree.
 *   - Before this existed the strip listed 13 sections and the tile grid 11: Roles &
 *     Permissions and Components & System were reachable only from the strip.
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
  /** Show in the section strip (Overview is the strip's own home). */
  strip?: boolean;
};

export const ADMIN_SECTIONS: AdminSection[] = [
  { id: 'overview', label: 'Overview', href: '/platform', sub: 'Tenant health at a glance', group: 'Tenant', minRole: 'builder', strip: true },

  // People
  { id: 'access', label: 'Users & Access', href: '/platform/access', sub: 'Invite, assign domains, offboard', group: 'People', minRole: 'admin', strip: true },
  { id: 'roles', label: 'Roles & Permissions', href: '/platform/roles', sub: 'What each role may do, per component', group: 'People', minRole: 'admin', strip: true },
  { id: 'domains', label: 'Domains', href: '/platform/domains', sub: 'Create domains & toggle optional layers', group: 'Tenant', minRole: 'admin', strip: true },

  // Models & cost — the LLM control room
  { id: 'models', label: 'Models & Providers', href: '/platform/models', sub: 'Routing defaults, caps, provider keys', group: 'Models & cost', minRole: 'admin', strip: true },
  { id: 'gateway', label: 'LLM Gateway', href: '/llm-gateway', sub: 'Live models, keys and usage through LiteLLM', group: 'Models & cost', minRole: 'builder', strip: true },
  { id: 'billing', label: 'Cost & Billing', href: '/platform/billing', sub: 'Spend envelope & premium cap', group: 'Models & cost', minRole: 'admin', strip: true },

  // Platform
  { id: 'components', label: 'Components & System', href: '/platform/components', sub: 'Every workload: status, toggle, self-heal', group: 'Platform', minRole: 'admin', strip: true },
  { id: 'mcp-apis', label: 'MCPs & APIs', href: '/platform/mcp-apis', sub: 'Registered MCP servers & API keys', group: 'Platform', minRole: 'admin', strip: true },
  { id: 'plugins', label: 'Plugins', href: '/platform/plugins', sub: 'Curate & install MCPs / skills', group: 'Platform', minRole: 'admin', strip: true },
  { id: 'oauth-apps', label: 'Drive OAuth apps', href: '/platform/oauth-apps', sub: 'Google & Microsoft apps for connected drives', group: 'Platform', minRole: 'admin', strip: true },
  { id: 'security', label: 'Security & Egress', href: '/platform/security', sub: 'Allowlist, OPA bundle, residency', group: 'Platform', minRole: 'admin', strip: true },
  { id: 'backups', label: 'Backups & Restore', href: '/platform/backups', sub: 'Status & guarded restore', group: 'Platform', minRole: 'admin', strip: true },
  { id: 'settings', label: 'Tenant Settings', href: '/platform/settings', sub: 'SSO, branding, tenant defaults', group: 'Tenant', minRole: 'admin', strip: true },

  // Me — self-service, the one builder-visible section
  { id: 'my-mcp', label: 'My MCP access', href: '/mcp', sub: 'Mint your MCP token; see your tools', group: 'Me', minRole: 'builder' },
  { id: 'my-settings', label: 'My Settings', href: '/settings', sub: 'Theme & deployment info', group: 'Me', minRole: 'builder' },
  { id: 'licenses', label: 'About / Licenses', href: '/about', sub: 'Bundled open source, by licence', group: 'Me', minRole: 'creator' },
];

/** The section strip: the sections an admin navigates between. */
export const STRIP_SECTIONS = ADMIN_SECTIONS.filter((s) => s.strip);

/** Tile grid, grouped — every section the viewer's role may reach. */
export const ADMIN_GROUP_ORDER: AdminGroup[] = ['Tenant', 'People', 'Models & cost', 'Platform', 'Me'];
