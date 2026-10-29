/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        metrics
 * FEATURE:    The Metrics tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Metrics tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'metrics',
  nav: { label: 'KPIs', icon: '∑', href: '/metrics', group: 'Context' },
  routes: ["/metrics"],
  api: ["/api/metrics"],
  mcpTools: ["metric-write"],
  policies: [],
  services: ["trino", "opensearch", "postgres"],
};
