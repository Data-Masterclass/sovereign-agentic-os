/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        workflows
 * FEATURE:    The Workflows tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Workflows tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'workflows',
  nav: { label: 'Workflows', icon: '⧉', href: '/workflows', group: 'Build' },
  routes: ["/workflows"],
  api: [],
  mcpTools: [],
  policies: [],
  services: ["opensearch"],
};
