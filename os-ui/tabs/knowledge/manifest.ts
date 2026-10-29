/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        knowledge
 * FEATURE:    The Knowledge tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Knowledge tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'knowledge',
  nav: { label: 'Knowledge', icon: '❦', href: '/knowledge', group: 'Context' },
  routes: ["/knowledge"],
  api: ["/api/knowledge", "/api/context"],
  mcpTools: ["knowledge-search", "knowledge-write"],
  policies: [],
  services: ["opensearch", "litellm", "docling", "dagster"],
};
