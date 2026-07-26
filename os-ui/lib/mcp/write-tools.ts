/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool, JsonSchema } from './server';
import { strategyWriteTools } from './strategy-tools';
import { marketplaceWriteTools } from './marketplace-tools';

import { dataWriteTools } from './data-write-tools';
import { knowledgeWriteTools } from './knowledge-write-tools';
import { fileWriteTools } from './file-write-tools';
import { promotionTools } from './promotion-write-tools';
import { metricWriteTools } from './metric-write-tools';
import { dashboardWriteTools } from './dashboard-write-tools';
import { bigbetWriteTools } from './bigbet-write-tools';
import { agentWriteTools } from './agent-write-tools';
import { softwareWriteTools } from './software-write-tools';

/**
 * The GOVERNED WRITE tools of the OS MCP — one per authoring action a case study
 * needs (create a dataset, author a workflow, upload a file, define a metric, build
 * a dashboard, frame a big bet, assemble an agent system). Each tool is a THIN
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
 * (data/knowledge/file/promotion/metric/dashboard/bigbet/agent/software), sharing
 * helpers via ./write-common. The public surface (ALL_WRITE_TOOLS,
 * __setRunOsTeamForTests, WriteToolSchema) is unchanged.
 */

export { dataWriteTools } from './data-write-tools';
export { knowledgeWriteTools } from './knowledge-write-tools';
export { fileWriteTools } from './file-write-tools';
export { promotionTools } from './promotion-write-tools';
export { metricWriteTools } from './metric-write-tools';
export { dashboardWriteTools } from './dashboard-write-tools';
export { bigbetWriteTools } from './bigbet-write-tools';
export { agentWriteTools, __setRunOsTeamForTests } from './agent-write-tools';
export { softwareWriteTools } from './software-write-tools';

export const ALL_WRITE_TOOLS: McpTool[] = [
  ...dataWriteTools,
  ...knowledgeWriteTools,
  ...fileWriteTools,
  ...metricWriteTools,
  ...dashboardWriteTools,
  ...bigbetWriteTools,
  ...agentWriteTools,
  ...promotionTools,
  // Software design fields (set_app_design via patchAppDesign — governed path).
  ...softwareWriteTools,
  // mcp-v2 surfaces wave — Strategy (pillar CRUD) + Marketplace (rate) writes.
  ...strategyWriteTools,
  ...marketplaceWriteTools,
];

// Keep an explicit reference to JsonSchema so the imported type is used (schemas above
// are structurally JsonSchema; this makes the dependency intentional + tree-checked).
export type WriteToolSchema = JsonSchema;
