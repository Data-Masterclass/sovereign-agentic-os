/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    The three tenant-connector registries — what this tenant ADMITS, as one admin-only block
 * USER STORY: As a platform admin I want the registries of what the tenant may connect to listed
 *             where connections live, instead of in an admin menu nobody reaches; as a creator I
 *             want my own connections untouched and no tiles I cannot use.
 * ARCHITECTURE:
 *   - Data only; no React, no I/O — so it is unit-testable (a .tsx file cannot be imported from a
 *     test in this harness). Rendered by tabs/connections/ui/AdminRegistries.tsx.
 *   - Moved off the Platform menu on 2026-10-30: all three are registries of what the tenant
 *     admits, not tenant administration. Connections then answers two questions — "what am I
 *     connected to" and "what may this tenant connect to" — so the admin half needs its own
 *     heading. The tab itself stays CREATOR-visible (settled by the user: "Creator can see their
 *     connections"); only this block is admin-gated.
 *   - The PAGES deliberately stay at their /platform/* routes. They inherit their admin gate from
 *     app/(govern)/platform/layout.tsx, which bounces any non-admin off every /platform sub-page.
 *     Re-implementing that gate elsewhere to make the file tree tidier is a security risk for no
 *     user-visible gain, so these are links, not a move. `minRole` here is advisory for
 *     rendering; the layout plus each route's adminCtx() is the real boundary.
 *   - `label`/`href`/`sub` are verbatim from tabs/admin/lib/sections.ts as of 769a1d0b, so the
 *     wording an admin already knows does not change under them.
 */
import type { Role } from '@core/kernel/session';

export type Registry = {
  /** Stable id — also the last segment of the route. */
  id: 'mcp-apis' | 'oauth-apps' | 'plugins';
  label: string;
  href: string;
  /** One line explaining what the admin does there — shown on the tile. */
  sub: string;
  minRole: Role;
};

export const REGISTRIES: Registry[] = [
  { id: 'mcp-apis', label: 'MCPs & APIs', href: '/platform/mcp-apis', sub: 'Registered MCP servers & API keys', minRole: 'admin' },
  { id: 'oauth-apps', label: 'Drive OAuth apps', href: '/platform/oauth-apps', sub: 'Google & Microsoft apps for connected drives', minRole: 'admin' },
  { id: 'plugins', label: 'Plugins', href: '/platform/plugins', sub: 'Curate & install MCPs / skills', minRole: 'admin' },
];
