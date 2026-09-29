/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool } from './server';
import { config } from '@/lib/core/config';

import { readTools } from '@/lib/experimental/mcp/discovery-read-tools';
import { waveBReadTools } from '@/lib/experimental/mcp/discovery-waveb-tools';
import { connectionTools } from '@/lib/experimental/mcp/discovery-connection-tools';
import { warehouseTools } from '@/lib/experimental/mcp/discovery-warehouse-tools';
import { omCatalogTools } from '@/lib/experimental/mcp/discovery-om-tools';
import { airflowTools } from '@/lib/experimental/mcp/discovery-airflow-tools';
import { scienceTools } from '@/lib/experimental/mcp/discovery-science-tools';

/**
 * Compatibility barrel — restores the pre-refactor always-on behavior after
 * the discovery-*.ts files moved to lib/experimental/mcp/ (#28). Same pattern
 * as write-tools.ts's ALL_WRITE_TOOLS: the source files moved, but this
 * unconditional composition is kept so nothing that already depends on these
 * tools always being present breaks. Real flag-gating for these (via
 * register-experimental.ts) is additive — server.ts dedupes against it.
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
];
