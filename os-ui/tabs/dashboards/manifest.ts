/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        dashboards
 * FEATURE:    The Dashboards tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Dashboards tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'dashboards',
  nav: { label: 'Dashboards', icon: '▦', href: '/dashboards', group: 'Build' },
  routes: ["/dashboards"],
  api: ["/api/dashboards"],
  mcpTools: ["dashboard-write"],
  policies: [],
  services: ["trino", "opensearch"],
};
