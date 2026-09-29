/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool, JsonSchema } from './server';
import { strategyWriteTools } from '@/lib/experimental/mcp/strategy-tools';
import { marketplaceWriteTools } from '@/lib/experimental/mcp/marketplace-tools';

import { dataWriteTools } from '@/lib/experimental/mcp/data-write-tools';
import { knowledgeWriteTools } from '@/lib/experimental/mcp/knowledge-write-tools';
import { fileWriteTools } from '@/lib/experimental/mcp/file-write-tools';
import { promotionTools } from '@/lib/experimental/mcp/promotion-write-tools';
import { metricWriteTools } from '@/lib/experimental/mcp/metric-write-tools';
import { dashboardWriteTools } from '@/lib/experimental/mcp/dashboard-write-tools';
import { bigbetWriteTools } from '@/lib/experimental/mcp/bigbet-write-tools';
import { agentWriteTools } from './agent-write-tools';
import { softwareWriteTools } from '@/lib/experimental/mcp/software-write-tools';
import { scienceWriteTools } from '@/lib/experimental/mcp/science-write-tools';
import { exposureWriteTools } from '@/lib/experimental/mcp/exposure-write-tools';

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

export { dataWriteTools } from '@/lib/experimental/mcp/data-write-tools';
export { knowledgeWriteTools } from '@/lib/experimental/mcp/knowledge-write-tools';
export { fileWriteTools } from '@/lib/experimental/mcp/file-write-tools';
export { promotionTools } from '@/lib/experimental/mcp/promotion-write-tools';
export { metricWriteTools } from '@/lib/experimental/mcp/metric-write-tools';
export { dashboardWriteTools } from '@/lib/experimental/mcp/dashboard-write-tools';
export { bigbetWriteTools } from '@/lib/experimental/mcp/bigbet-write-tools';
export { agentWriteTools, __setRunOsTeamForTests } from './agent-write-tools';
export { softwareWriteTools } from '@/lib/experimental/mcp/software-write-tools';
export { scienceWriteTools } from '@/lib/experimental/mcp/science-write-tools';
export { exposureWriteTools } from '@/lib/experimental/mcp/exposure-write-tools';

export const ALL_WRITE_TOOLS: McpTool[] = [
  ...dataWriteTools,
  ...knowledgeWriteTools,
  ...fileWriteTools,
  ...metricWriteTools,
  ...dashboardWriteTools,
  ...bigbetWriteTools,
  ...agentWriteTools,
  // Science (Phase D): the full journey from an agent — create_model / train_model / get_model_status.
  ...scienceWriteTools,
  ...promotionTools,
  // Software design fields (set_app_design via patchAppDesign — governed path).
  ...softwareWriteTools,
  // Lakehouse expose/adopt parity (Phase 4): exposure CRUD + catalog snapshot/classify
  // (connections) + list_exposed_tables/adopt_exposed_table (data) — same libs as the UI.
  ...exposureWriteTools,
  // mcp-v2 surfaces wave — Strategy (pillar CRUD) + Marketplace (rate) writes.
  ...strategyWriteTools,
  ...marketplaceWriteTools,
];

// Keep an explicit reference to JsonSchema so the imported type is used (schemas above
// are structurally JsonSchema; this makes the dependency intentional + tree-checked).
export type WriteToolSchema = JsonSchema;
