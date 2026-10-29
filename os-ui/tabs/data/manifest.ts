/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        data
 * FEATURE:    The Data tab's contract — nav entry, routes, APIs, MCP tools, services
 * USER STORY: As an operator I want to know exactly what the Data tab owns and what it needs
 *             deployed, so I can switch it off without leaving a broken menu entry behind.
 * ARCHITECTURE:
 *   - Data only; no logic, no I/O. Read by scripts/check-structure.mjs and scripts/build-docs.mjs.
 *   - `services` lists the deployed components this tab needs (chart `enabled` flags decide).
 */
import type { TabManifest } from '@core/manifest';

export const manifest: TabManifest = {
  key: 'data',
  nav: { label: 'Data', icon: '▤', href: '/data', group: 'Context' },
  routes: ["/data"],
  api: ["/api/data", "/api/tables", "/api/query", "/api/catalog"],
  mcpTools: ["data-query", "dataset-write"],
  policies: [],
  services: ["postgres", "opensearch", "minio", "trino", "polaris", "dbt", "dagster", "data-runner", "query-tool"],
};
