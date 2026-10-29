/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       core
 * FEATURE:    The tab contract — what a tab declares about itself
 * USER STORY: As an operator I want to run only the tabs my deployment needs, and have a tab
 *             whose services are switched off disappear from the navigation instead of failing
 *             when someone clicks it; as a maintainer I want one machine-readable place that
 *             says which routes, APIs, MCP tools and policies a tab owns.
 * ARCHITECTURE:
 *   - Pure types + a registry. No I/O, no imports from any tab (the kernel never depends on one).
 *   - Each tab exports `manifest` from tabs/<key>/manifest.ts; scripts/check-structure.mjs
 *     requires the file and scripts/build-docs.mjs renders it into the code map.
 *   - `services` are the deployed components the tab needs; the chart's enabled flags decide
 *     whether they exist, and OS_ENABLED_TABS gates the nav (see core/kernel/tabs.ts).
 */
import type { Role } from '@core/kernel/session';

export type ServiceName =
  | 'postgres' | 'opensearch' | 'valkey' | 'minio' | 'litellm' | 'opa' | 'agent-runtime'
  | 'langfuse' | 'clickhouse' | 'trino' | 'polaris' | 'dbt' | 'dagster' | 'docling'
  | 'data-runner' | 'query-tool' | 'egress-proxy' | 'web-fetch';

export type TabManifest = {
  /** The feature key OS_ENABLED_TABS switches on. Matches the folder name. */
  key: string;
  nav: { label: string; icon: string; href: string; group: 'Entry' | 'Context' | 'Build' | 'Manage'; minRole?: Role };
  /** Page routes this tab owns (as served by app/). */
  routes: string[];
  /** API prefixes this tab owns. */
  api: string[];
  /** MCP tool bundles registered from tabs/<key>/mcp. */
  mcpTools: string[];
  /** OPA policy files under tabs/<key>/policy. */
  policies: string[];
  /** Deployed components the tab needs to function. */
  services: ServiceName[];
};
