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

// ================================= SCIENCE ====================================
// The Science read surface: what the caller can SCORE through the governed predict
// door. Reads the SAME registry `science_predict`'s gate (`authorizePredict`) reads,
// RLS-scoped with `listModelsForUser` — so list/get and predict can never disagree.

/** The model card shape both science tools return (never the raw model). */
function modelCard(m: ReturnType<typeof listModelsForUser>[number]) {
  const production = m.versions.find((v) => v.stage === 'Production') ?? m.versions[0];
  // The metric NAME + VALUE for the headline version — auc/rmse/… (never a mislabeled AUC).
  // Prefer the model's recorded metrics; fall back to the version's own name/value.
  const metricName = m.metrics?.primaryMetric ?? production?.metricName ?? m.spec?.optimizeMetric;
  const metricValue = typeof m.metrics?.primary === 'number' ? m.metrics.primary : production?.metric ?? production?.auc;
  return {
    model: m.model,
    name: m.name,
    owner: m.owner,
    domain: m.domain,
    tier: m.tier,
    stage: m.stage,
    // The MLOps build lifecycle (draft → training → … → deployed) — what state the model is really in.
    buildState: m.buildState ?? 'draft',
    frontDoors: m.frontDoors,
    consumptionMode: m.consumptionMode,
    versions: m.versions,
    metrics: production
      ? { version: production.version, metricName, metric: metricValue, auc: production.auc, certified: production.certified }
      : null,
    // Real prediction usage recorded on every predict (absent until first called) — never fabricated.
    usage: m.usage
      ? { count: m.usage.count, denied: m.usage.denied, lastCalledAt: m.usage.lastCalledAt ?? null }
      : null,
    // The honest last failure reasons, when any (so an agent can interpret + retry).
    lastErrors: {
      training: m.lastTrainingError ?? null,
      deploy: m.lastDeployError ?? null,
    },
    // The churn model's serving contract (features + score bands) — stated only for
    // the model it is true of; other models carry their own cards as they register.
    ...(m.model === CHURN.model
      ? {
          features: [...CHURN.features],
          defaultFeatures: DEFAULT_FEATURES,
          scoreBands: { high: '>= 0.66', medium: '>= 0.33', low: '< 0.33' },
        }
      : {}),
  };
}

const mlServing = () => ({
  mlEnabled: config.mlEnabled,
  ...(config.mlEnabled
    ? {}
    : { note: 'ML serving (Layer 4) is OFF for this tenant — science_predict returns not_found until an Admin sets ml.enabled=true. The registry below is still real.' }),
});

export const scienceTools: McpTool[] = [
  {
    name: 'list_models',
    tab: 'science',
    minRole: 'creator',
    description:
      'List the ML models YOU can score through the governed predict door — your own My-scope models, your Domain’s, and Company-certified ones (the same tier ladder as every artifact; promoting a model is what widens who may call it). Path: step 1 of the Science golden path (guide: sovereign-os://guide/path/science). Before: whoami. After: get_model for one card, then science_predict. Governance: read-only, RLS-scoped to your identity — another user’s My-scope model never appears. Honest: when ml.enabled=false the response SAYS SO (predict will 404 until an Admin enables it); an empty tenant returns an empty list, never an invented model.',
    inputSchema: NO_ARGS,
    call: async (user) => {
      const viewer: ModelViewer = { id: user.id, domains: user.domains };
      return { ...mlServing(), models: listModelsForUser(viewer).map(modelCard) };
    },
  },
  {
    name: 'get_model',
    tab: 'science',
    minRole: 'creator',
    description:
      'Read one model’s full card: features, default feature vector, score bands/threshold, registry versions + the headline metric (name + value — auc/rmse, never a mislabeled AUC), the build lifecycle state (draft → training → … → deployed), real prediction usage (count / denied / last called), the last training/deploy error (if any), tier (who may call it) and serving status (stage, front doors, ml.enabled). Path: step 2 of the Science golden path. Before: list_models. After: train_model / get_model_status while it is being built, or science_predict once deployed. Governance: read-only; a model outside your tier scope → not_found (no existence leak) — the same visibility rule `science_predict`’s gate enforces.',
    inputSchema: {
      type: 'object',
      properties: { model: { type: 'string', description: 'Registry model name from list_models, e.g. "churn_model".' } },
      required: ['model'],
      examples: [{ model: 'churn_model' }],
    },
    call: async (user, args) => {
      const name = str(args.model).trim();
      if (!name) fail('get_model needs a `model` (from list_models)', 400);
      const viewer: ModelViewer = { id: user.id, domains: user.domains };
      const m = listModelsForUser(viewer).find((x) => x.model === name || x.id === name);
      if (!m) fail(`Model not found: ${name}`, 404); // unseeable == unknown (no leak)
      return { ...mlServing(), ...modelCard(m) };
    },
  },
];

