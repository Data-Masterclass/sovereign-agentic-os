/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        admin
 * FEATURE:    The Admin tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Admin tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'admin',
  nav: { label: 'Admin', icon: '❖', href: '/platform', group: 'Manage', minRole: 'builder' },
  routes: ["/platform", "/components", "/llm-gateway", "/mcp", "/about", "/settings"],
  api: ["/api/platform", "/api/platform-admin", "/api/users", "/api/mcp"],
  mcpTools: ["platform", "discovery-read"],
  policies: [],
  services: ["opensearch", "postgres", "litellm", "opa"],
};
