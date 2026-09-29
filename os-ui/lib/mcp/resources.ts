/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Compatibility barrel — the real implementation moved to
 * lib/experimental/mcp/resources.ts (#28), since most resources (data/
 * knowledge/files/dashboards/bigbets/software/connections/science/strategy)
 * are non-base; only the `agent` resource + guide resources are base. Same
 * pattern as write-tools.ts/discovery-tools.ts: re-exported unconditionally
 * here so server.ts's existing import keeps working, behavior unchanged.
 */
export {
  RESOURCES,
  RESOURCE_TEMPLATES,
  resourcesForTab,
  templatesForTab,
  type McpResource,
  type McpResourceTemplate,
} from '@/lib/experimental/mcp/resources';
