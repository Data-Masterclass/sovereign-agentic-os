/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool, JsonSchema } from '@core/mcp/server';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles,
  type Principal,
} from '@core/mcp/write-common';

// --- Governed lib functions (the EXACT same the UI + /api routes call) ---------
import {
  createDataset,
  buildVersion,
  setDocs as setDatasetDocs,
  requestPromotion as requestDatasetPromotion,
  getDataset,
  archiveDataset,
  deleteDataset,
  defineMeasure,
  buildGoldJoin as commitGoldJoin,
  addCheck,
  builtLayerFqn,
  listGovernedDatasets,
  type PromotionRequest,
} from '@tabs/data/lib/store';
import { runQualityChecks } from '@tabs/data/lib/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@tabs/data/lib/index';
import { queryRun } from '@core/infra/governed';
import { publishPromotionLive } from '@tabs/data/lib/publish-server';
import { enqueue, getApproval, decide, listApprovals } from '@core/policy/approvals';
import { canBuildStage, canPassThrough, stageArtifact } from '@tabs/data/lib/panels';
import { viewName, registryDimensionMembers } from '@tabs/data/lib/metrics';
import { ingestAndRegisterBronze } from '@tabs/data/lib/ingest';
import { buildStage, commitLayerVersion } from '@tabs/data/lib/build/server';
import {
  silverPlan,
  goldJoinPlan,
  goldMeasureToModel,
  CAST_TYPES,
  type TransformOp,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type JoinType,
} from '@tabs/data/lib/transform';
import { assetTarget } from '@tabs/data/lib/store-fqn';
import type { ExecuteIdentity } from '@core/infra/governed';
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc, DatasetUpstream } from '@tabs/data/lib/index';
import { measureFromForm, measureMember, type MetricForm, type GuidedFilter, type GuidedWindow } from '@tabs/metrics/lib/model';
import type { MeasureType } from '@tabs/data/lib/metrics';
import { buildMetric } from '@tabs/metrics/lib/build/server';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';
import type { Granularity } from '@tabs/metrics/lib/explorer';
import { getMetric } from '@tabs/metrics/lib/store';
import { governMetric, canPromote as canPromoteMetric } from '@tabs/metrics/lib/governance';
import { transition as transitionDataset } from '@tabs/data/lib/store';

import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  getDomainKnowledge,
  archiveWorkflow,
  deleteWorkflow,
} from '@tabs/knowledge/lib/store';
import { knowledgeConsumers } from '@tabs/knowledge/lib/consumers';
import { fileArtifactPromotion, promoteThroughSeam, isLadderKind, type LadderKind } from '@core/policy/ladder';
import { pendingHandle } from '@core/mcp/pending';
import {
  serializeWorkflow,
  deriveActors,
  ACTOR_TYPES,
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
  type Actor,
} from '@tabs/knowledge/lib/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@tabs/knowledge/lib/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  attachObject,
  objectKeyForAsset,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
  type FilePromotionRequest,
} from '@tabs/files/lib/store';
import { reindexFile } from '@tabs/files/lib/pipeline-server';
import { putBlob } from '@tabs/files/lib/object-store';
import type { Sensitivity } from '@tabs/files/lib/asset-schema';

import { saveDashboard } from '@tabs/dashboards/lib/store';
import { fromTiles, missingPanelMembers, type ChartSpec } from '@tabs/dashboards/lib/model';
import { panelViewsFor, type RegistryViewDims } from '@tabs/dashboards/lib/panel-views';
import { listMetrics } from '@tabs/metrics/lib/store';
import { claimsFromUser, delegate } from '@tabs/data/lib/identity';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
  getSystemForRun,
} from '@tabs/agents/lib/store';
import { isTemplateKey } from '@tabs/agents/lib/templates';
import { buildSystem } from '@tabs/agents/lib/build/server';

import { patchAppDesign, getAppForUser, type AppEpic } from '@tabs/software/lib/apps';
import { normalizeContextGrants } from '@core/kernel/context-grants';

// ============================== DASHBOARDS ====================================
export const dashboardWriteTools: McpTool[] = [
  {
    name: 'create_dashboard',
    tab: 'dashboards',
    minRole: 'creator',
    description:
      'Create (or replace) a dashboard (also called: report, business intelligence (BI), data visualization) you own — tiles/charts that reference GOVERNED metric members. Runs in YOUR My scope with no approval; this call PERSISTS the spec. Panels render NATIVELY at View time (Apache ECharts over governed Trino SQL) — there is no external BI import step, and every panel re-queries AS THE VIEWER so per-viewer row-level security is enforced live (a best-effort offline-mock only if the lakehouse is unreachable). Same governed path as the Dashboards tab. Sharing it wider is the separate governed promote ladder (owner files request_promotion → a domain admin approves).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable id (to replace an existing one you own); auto-generated if omitted.' },
        name: { type: 'string', description: 'Dashboard name, e.g. "Sales Overview".' },
        view: { type: 'string', description: 'The governed view (one gold dataset’s view) the charts bind to.' },
        charts: {
          type: 'array',
          description: 'At least one chart on a governed metric member.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              vizType: { type: 'string', enum: ['big_number_total', 'line', 'bar', 'table'] },
              metric: { type: 'string', description: 'Governed metric member, e.g. "Orders.revenue".' },
              dimensions: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'vizType', 'metric'],
          },
        },
      },
      required: ['name', 'view', 'charts'],
      examples: [
        { name: 'Sales Overview', view: 'Orders', charts: [{ name: 'Total revenue', vizType: 'big_number_total', metric: 'Orders.revenue' }] },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_dashboard needs a `name`', 400);
      const view = str(args.view).trim();
      if (!view) fail('create_dashboard needs a `view` (the gold dataset’s governed view)', 400);
      const charts = (Array.isArray(args.charts) ? args.charts : []) as ChartSpec[];
      if (!charts.length) fail('a dashboard needs at least one chart on a governed metric', 400);
      const id = str(args.id).trim() || `dash_${slug(name)}_${rand()}`;
      // Scope the dashboard's governed view to the caller's domain. Tier-1 native dashboards
      // render at VIEW time (Apache ECharts on the governed metric layer, per-viewer RLS) —
      // there is no external import step, so create_dashboard is persist-only (mirrors
      // /api/dashboards/build).
      const spec = fromTiles(name, view, charts, user.domains[0]);
      const rec = saveDashboard(P(user), id, spec);
      // FLAG AT CREATE, never silently degrade (Northpeak fix): check every chart's
      // requested members against the served model (registry fallback). The dashboard IS
      // created with its full spec — but any member the served model lacks is reported
      // here AND warned at render, so a bar can never silently collapse to a single
      // un-grouped column because a domain table is missing/stale.
      const warnings: string[] = [];
      try {
        const groups = listMetrics(P(user));
        const members = [...groups.mine, ...groups.domain, ...groups.marketplace].map((m) => m.member);
        const registryDims: RegistryViewDims = new Map(
          listGovernedDatasets().map((d) => [viewName(d), registryDimensionMembers(d)]),
        );
        const views = panelViewsFor(members, registryDims);
        const v = views.find((x) => x.view === view);
        const served = v
          ? { measures: v.measures, dimensions: v.dimensions, timeDimensions: v.timeDimensions }
          : { measures: [], dimensions: [], timeDimensions: [] };
        for (const chart of rec.spec.charts) {
          const missing = missingPanelMembers(chart, served);
          if (missing.length > 0) {
            warnings.push(
              `Chart “${chart.name}”: member${missing.length === 1 ? '' : 's'} ${missing.map((m) => `“${m}”`).join(', ')} not available on view “${view}” — the dataset's domain table may be missing/stale and need re-promotion. The chart keeps its spec and will show an honest warning until the model serves it.`,
            );
          }
        }
      } catch {
        /* the flagging is additive — never fail a successful create for it */
      }
      return { id: rec.id, tier: rec.tier, spec: rec.spec, ...(warnings.length ? { warnings } : {}) };
    },
  },
];

