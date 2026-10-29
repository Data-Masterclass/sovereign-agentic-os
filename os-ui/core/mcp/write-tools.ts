/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool, JsonSchema } from '@core/mcp/server';

import { dataWriteTools } from '@core/mcp/experimental/data-write-tools';
import { knowledgeWriteTools } from '@tabs/knowledge/mcp/knowledge-write-tools';
import { fileWriteTools } from '@tabs/files/mcp/file-write-tools';
import { promotionTools } from '@core/mcp/experimental/promotion-write-tools';
import { metricWriteTools } from '@tabs/metrics/mcp/metric-write-tools';
import { dashboardWriteTools } from '@tabs/dashboards/mcp/dashboard-write-tools';
import { agentWriteTools } from '@core/mcp/agent-write-tools';
import { softwareWriteTools } from '@tabs/software/mcp/software-write-tools';
import { exposureWriteTools } from '@core/mcp/experimental/exposure-write-tools';

/**
 * The GOVERNED WRITE tools of the OS MCP — one per authoring action a case study
 * needs (create a dataset, author a workflow, upload a file, define a metric, build
 * a dashboard, assemble an agent system). Each tool is a THIN
 * adapter that delegates to the EXACT SAME lib function the Data/Knowledge/Files/…
 * tabs and `/api/*` routes call, under the caller's delegated identity — so OPA,
 * DLS, Langfuse audit and the role ladder apply UNCHANGED. There is no privileged
 * path here: identity + the role floor come from the session, NEVER the request body.
 *
 * The lockdown, restated at the tool boundary (mirrors the store gates it calls):
 *   • a `creator` CREATES in their own domain, but may NOT promote/publish/certify;
 *   • promote_* / publish_* stay `minRole: 'builder'` (certify stays Admin in-lib).
 *
 * This module is a BARREL: each per-domain cluster lives in its own file
 * (data/knowledge/file/promotion/metric/dashboard/agent/software), sharing
 * helpers via ./write-common. The public surface (ALL_WRITE_TOOLS,
 * __setRunOsTeamForTests, WriteToolSchema) is unchanged.
 */

export { dataWriteTools } from '@core/mcp/experimental/data-write-tools';
export { knowledgeWriteTools } from '@tabs/knowledge/mcp/knowledge-write-tools';
export { fileWriteTools } from '@tabs/files/mcp/file-write-tools';
export { promotionTools } from '@core/mcp/experimental/promotion-write-tools';
export { metricWriteTools } from '@tabs/metrics/mcp/metric-write-tools';
export { dashboardWriteTools } from '@tabs/dashboards/mcp/dashboard-write-tools';
export { agentWriteTools, __setRunOsTeamForTests } from '@core/mcp/agent-write-tools';
export { softwareWriteTools } from '@tabs/software/mcp/software-write-tools';
export { exposureWriteTools } from '@core/mcp/experimental/exposure-write-tools';

export const ALL_WRITE_TOOLS: McpTool[] = [
  ...dataWriteTools,
  ...knowledgeWriteTools,
  ...fileWriteTools,
  ...metricWriteTools,
  ...dashboardWriteTools,
  ...agentWriteTools,
  ...promotionTools,
  // Software design fields (set_app_design via patchAppDesign — governed path).
  ...softwareWriteTools,
  // Lakehouse expose/adopt parity (Phase 4): exposure CRUD + catalog snapshot/classify
  // (connections) + list_exposed_tables/adopt_exposed_table (data) — same libs as the UI.
  ...exposureWriteTools,
];


// Keep an explicit reference to JsonSchema so the imported type is used (schemas above
// are structurally JsonSchema; this makes the dependency intentional + tree-checked).
export type WriteToolSchema = JsonSchema;
