/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        monitoring
 * FEATURE:    The Monitoring tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Monitoring tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'monitoring',
  nav: { label: 'Monitoring', icon: '◷', href: '/monitoring', group: 'Manage', minRole: 'builder' },
  routes: ["/monitoring"],
  // `/api/platform-admin/billing` serves the Cost & Spend section (it moved here
  // from Platform with the surface). It stays under the platform-admin prefix and
  // stays `adminCtx()`-gated — the gate is correct either way, and moving the file
  // would have broken nothing and gained nothing.
  api: ["/api/monitoring", "/api/traces", "/api/status", "/api/platform-admin/billing"],
  mcpTools: [],
  policies: [],
  services: ["langfuse", "clickhouse", "opensearch"],
};
