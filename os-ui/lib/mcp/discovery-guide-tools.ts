/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from './server';
import {
  P, fail, str, strArr, NO_ARGS, idArg, resolveQueryable,
  type Principal,
} from './discovery-common';

// --- Governed read/list lib functions (the EXACT same the UI + /api call) ------
import { listDatasets, getDataset } from '@/lib/data/store';
import { listWorkflows, getWorkflow } from '@/lib/knowledge/store';
import { listFiles, searchFiles, getFile } from '@/lib/files/store';
import { listMetrics } from '@/lib/metrics/store';
import { listDashboards, getDashboard } from '@/lib/dashboards/store';
import { normalizePanel, panelMetrics } from '@/lib/dashboards/model';
import { listBets, getSolution } from '@/lib/bigbets/store';
import { buildBetView } from '@/lib/bigbets/server';
import { getSystem } from '@/lib/agents/store';
import {
  listAppsForUser,
  getAppForUser,
  listAppFilesForViewer,
  readAppFileForViewer,
  templateFiles,
  refreshActionsStage,
} from '@/lib/software/apps';
import { forgejoReachable, getSnapshot } from '@/lib/software/server';
import { getReviewCard, listReviewCards, PREVIEW_PENDING_NOTE } from '@/lib/software/review';
import {
  listConnectionsForUser,
  getConnectionForUser,
  createConnection,
  testConnection,
  callConnectionTool,
  warehouseRegistration,
  registerWarehouseCatalog,
  discoverWarehouse,
  importWarehouseTable,
  CONNECTION_TEMPLATES,
  isPersonalConnectable,
  type ConnectionTemplateKey,
  type WarehouseCreateInput,
  type AirflowCreateInput,
} from '@/lib/connections';
import type { AirflowAuthType } from '@/lib/connections/schema';
import {
  resolveOmCatalog,
  omListDomains,
  omListDataProducts,
  omListTables,
  omSearch,
  omLineage,
  previewOmSyncForConnection,
  previewDqSyncForConnection,
} from '@/lib/connections/openmetadata';
import { previewCatalogIngest } from '@/lib/connections/openmetadata-ingest';
import { WAREHOUSE_PROVIDERS } from '@/lib/connections/warehouse/registry';
import { WAREHOUSE_PLATFORMS, type WarehousePlatform } from '@/lib/connections/warehouse/types';
import { promoteThroughSeam } from '@/lib/governance/ladder';
import { enqueue } from '@/lib/governance/approvals';
import { scaffoldCubeYaml, cubeViewName } from '@/lib/data/metrics';
import { cubeDeliverable } from '@/lib/data/cube-models';
import { loadGuide, isGuidePath, GUIDE_PATHS, type GuidePath } from '@/lib/tabs/guides';
import { config } from '@/lib/core/config';
import { queryRun } from '@/lib/infra/governed';
import { versionTarget } from '@/lib/data/store-fqn';
import { builtLayerFqn } from '@/lib/data/store';
import type { Layer } from '@/lib/data';
import { LAYERS } from '@/lib/data';
import {
  assembleProfile,
  parseDescribe,
  previewSql,
  statsSql,
  topValuesSql,
  type ProfileColumn,
} from '@/lib/data/profile';
import { getMetric } from '@/lib/metrics/store';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';
import { claimsFromUser, delegate } from '@/lib/data/identity';
import { listModelsForUser, type ModelViewer } from '@/lib/science';
import { CHURN, DEFAULT_FEATURES } from '@/lib/science/churn';

// =================================== META =====================================
export const guideTool: McpTool = {
  name: 'get_guide',
  tab: 'meta',
  minRole: 'creator',
  description:
    `Read a golden-path GUIDE (the same markdown as the sovereign-os://guide/* resources) so tools-only clients get the full pathway. Call with NO argument (or path="how-to-use") for a "How to use this MCP" orientation: what the OS is, your first 3 moves, the role summary, all pathway names, and the build-on-what-exists rule. Valid paths: ${GUIDE_PATHS.join(', ')}. Governance: read-only, identical for every role.`,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', enum: [...GUIDE_PATHS], description: 'Which guide to read. Omit (or pass "how-to-use") for the "How to use this MCP" orientation.' } },
    required: [],
    examples: [{}, { path: 'how-to-use' }, { path: 'overview' }, { path: 'data' }],
  },
  call: async (_user, args) => {
    const raw = str(args.path).trim();
    const path: GuidePath = isGuidePath(raw) ? raw : 'how-to-use';
    const text = loadGuide(path);
    if (!text) fail(`Guide not found: ${path}`, 404);
    return text;
  },
};

