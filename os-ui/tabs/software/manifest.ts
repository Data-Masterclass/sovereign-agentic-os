/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        software
 * FEATURE:    The Software tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Software tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'software',
  nav: { label: 'Software', icon: '⌘', href: '/software', group: 'Build' },
  routes: ["/software", "/apps"],
  api: ["/api/software", "/api/apps", "/api/artifacts"],
  mcpTools: ["software-write"],
  policies: [],
  services: ["opensearch", "minio", "litellm"],
};
