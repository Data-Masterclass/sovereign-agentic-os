/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        agents
 * FEATURE:    The Agents tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Agents tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'agents',
  nav: { label: 'Agents', icon: '✦', href: '/agents', group: 'Build' },
  routes: ["/agents"],
  api: ["/api/agents", "/api/agent", "/api/agent-chat", "/api/assistant"],
  mcpTools: ["agent-write"],
  policies: [],
  services: ["agent-runtime", "litellm", "opa", "langfuse", "opensearch", "postgres"],
};
