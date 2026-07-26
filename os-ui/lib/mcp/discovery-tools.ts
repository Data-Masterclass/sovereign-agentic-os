/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool } from './server';
import { config } from '@/lib/core/config';

import { readTools } from './discovery-read-tools';
import { waveBReadTools } from './discovery-waveb-tools';
import { connectionTools } from './discovery-connection-tools';
import { warehouseTools } from './discovery-warehouse-tools';
import { omCatalogTools } from './discovery-om-tools';
import { airflowTools } from './discovery-airflow-tools';
import { scienceTools } from './discovery-science-tools';
import { guideTool } from './discovery-guide-tools';

/**
 * The DISCOVERY tools — read-only adapters that make the OS legible so an AI
 * BUILDS ON WHAT EXISTS instead of re-creating it. Each is a THIN delegate over
 * the SAME governed lib function the UI calls, under the caller's delegated
 * identity, so OPA + document/row-level-security (mine/shared/marketplace
 * grouping) + Langfuse audit apply UNCHANGED. No privileged path here: identity
 * comes from the session, the role floor is re-checked in `handleRpc`, and the
 * governed fn is always the real authority.
 *
 * These mirror the dynamic `sovereign-os://my/*` resources one-for-one — the
 * deliberate redundancy so tools-only clients (ChatGPT, several runtimes) that
 * ignore MCP resources can still discover everything.
 *
 * This module is a BARREL: each per-domain cluster lives in its own file
 * (read/waveb/connection/warehouse/om/airflow/science/guide), sharing helpers
 * via ./discovery-common. The public surface (DISCOVERY_TOOLS) is unchanged.
 */

export const DISCOVERY_TOOLS: McpTool[] = [
  ...readTools,
  ...waveBReadTools,
  ...connectionTools,
  // Warehouse tools appear ONLY when the operator enabled external connectors —
  // nothing new surfaces on the MCP when EXTERNAL_CONNECTORS_ENABLED is off.
  ...(config.externalConnectorsEnabled ? warehouseTools : []),
  // External-OM read tools appear ONLY when the operator enabled OpenMetadata
  // connections — nothing new surfaces when OPENMETADATA_CONNECT_ENABLED is off.
  ...(config.openmetadataConnectEnabled ? omCatalogTools : []),
  // Airflow tools are always available — the connector is user-facing (a plain API
  // connector); the tools resolve to a no-op unless an airflow connection exists.
  ...airflowTools,
  ...scienceTools,
  guideTool,
];
