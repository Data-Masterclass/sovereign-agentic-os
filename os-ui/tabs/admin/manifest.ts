/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        admin
 * FEATURE:    The Platform tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Platform tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 *   - The folder key stays `admin` (it is the `feature` key in OS_ENABLED_TABS and the import
 *     path `@tabs/admin/*`); only the user-facing LABEL became Platform on 2026-10-30.
 *   - `nav` here is dead metadata — the sidebar reads core/kernel/tabs.ts — but it must not
 *     contradict the live label, so it is kept in step.
 *   - `routes` lists the route PREFIXES this tab owns, not every page. `/platform` therefore
 *     covers both the one tabbed route and everything still under it: the redirect stubs left
 *     by the 2026-10-30 restructure (`/platform/{access,backups,components,domains,models,
 *     settings}` → `/platform?section=<id>`) and the three tenant-registry pages that still
 *     live there (`/platform/{mcp-apis,oauth-apps,plugins}`, linked from Connections).
 *     `/mcp`, `/about` and `/settings` are reached from the sidebar account menu now, not from
 *     this tab's menu, but the routes are unchanged and `/mcp` still renders this tab's UI.
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'admin',
  nav: { label: 'Platform', icon: '❖', href: '/platform', group: 'Manage', minRole: 'builder' },
  routes: ["/platform", "/components", "/mcp", "/about", "/settings"],
  api: ["/api/platform", "/api/platform-admin", "/api/users", "/api/mcp"],
  mcpTools: ["platform", "discovery-read"],
  policies: [],
  services: ["opensearch", "postgres", "litellm", "opa"],
};
