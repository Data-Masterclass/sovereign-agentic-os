/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        governance
 * FEATURE:    The Governance tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Governance tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'governance',
  nav: { label: 'Governance', icon: '⚖', href: '/governance', group: 'Manage', minRole: 'builder' },
  routes: ["/governance"],
  // `/api/git` is the generic versioning surface (stream G): the Repositories section reads
  // `?action=repos` from it, and the shared git badge reads the per-object actions.
  api: ["/api/governance", "/api/policy", "/api/git"],
  mcpTools: ["governance"],
  policies: [],
  services: ["opa", "opensearch", "postgres"],
};
