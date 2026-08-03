/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from './server';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles,
  type Principal,
} from './write-common';

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
} from '@/lib/data/store';
import { runQualityChecks } from '@/lib/data/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@/lib/data';
import { cubeMeta, queryRun } from '@/lib/infra/governed';
import { publishPromotionLive } from '@/lib/data/publish-server';
import { enqueue, getApproval, decide, listApprovals } from '@/lib/governance/approvals';
import { canBuildStage, canPassThrough, stageArtifact } from '@/lib/data/panels';
import { cubeViewName, registryDimensionMembers, scaffoldCubeYaml } from '@/lib/data/metrics';
import { ingestAndRegisterBronze } from '@/lib/data/ingest';
import { buildStage, commitLayerVersion } from '@/lib/data/build/server';
import {
  silverPlan,
  goldJoinPlan,
  goldMeasureToCube,
  CAST_TYPES,
  type TransformOp,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type JoinType,
} from '@/lib/data/transform';
import { assetTarget } from '@/lib/data/store-fqn';
import type { ExecuteIdentity } from '@/lib/infra/governed';
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc, DatasetUpstream } from '@/lib/data';
import { measureFromForm, measureMember, type MetricForm, type GuidedFilter, type GuidedWindow } from '@/lib/metrics/model';
import type { MeasureType } from '@/lib/data/metrics';
import { buildMetric } from '@/lib/metrics/build/server';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';
import { getMetric } from '@/lib/metrics/store';
import { governMetric, canPromote as canPromoteMetric } from '@/lib/metrics/governance';
import { transition as transitionDataset } from '@/lib/data/store';

import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  getDomainKnowledge,
  archiveWorkflow,
  deleteWorkflow,
} from '@/lib/knowledge/store';
import { knowledgeConsumers } from '@/lib/knowledge/consumers';
import { fileArtifactPromotion, promoteThroughSeam, isLadderKind, type LadderKind } from '@/lib/governance/ladder';
import { pendingHandle } from '@/lib/mcp/pending';
import {
  serializeWorkflow,
  deriveActors,
  ACTOR_TYPES,
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
  type Actor,
} from '@/lib/knowledge/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@/lib/knowledge/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  attachObject,
  objectKeyForAsset,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
  type FilePromotionRequest,
} from '@/lib/files/store';
import { reindexFile } from '@/lib/files/pipeline-server';
import { putBlob } from '@/lib/files/object-store';
import type { Sensitivity } from '@/lib/files/asset-schema';

import { saveDashboard } from '@/lib/dashboards/store';
import { fromTiles, missingPanelMembers, type ChartSpec } from '@/lib/dashboards/model';
import { narrowCubeMeta, type RegistryViewDims } from '@/lib/dashboards/cube-meta';
import { listMetrics } from '@/lib/metrics/store';
import { claimsFromUser, delegate } from '@/lib/data/identity';

import {
  createBet,
  getBet,
  updateBet,
  addComponent,
  archiveBet,
  unarchiveBet,
  deleteBet,
  restoreBetVersion,
  setBetWorkflow,
  wireComponents,
  unwireComponents,
  canEdit as canEditBet,
  type CreateBetInput,
} from '@/lib/bigbets/store';
import { getPillar } from '@/lib/strategy/pillars';
import { deriveBetName, INTERPLAY_RELATIONS, type BigBet, type InterplayRelation, type Tab as BetTab, type ValueBasis } from '@/lib/bigbets';
import { resolveLinkedComponent } from '@/lib/bigbets/attach-server';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
  getSystemForRun,
} from '@/lib/agents/store';
import { isTemplateKey } from '@/lib/agents/templates';
import { buildSystem } from '@/lib/agents/build/server';

import { patchAppDesign, getAppForUser, type AppEpic } from '@/lib/software/apps';
import { normalizeContextGrants } from '@/lib/core/context-grants';

// ============================== DASHBOARDS ====================================
export const dashboardWriteTools: McpTool[] = [
  {
    name: 'create_dashboard',
    tab: 'dashboards',
    minRole: 'creator',
    description:
      'Create (or replace) a dashboard (also called: report, business intelligence (BI), data visualization) you own — tiles/charts that reference GOVERNED metric members. Runs in YOUR My scope with no approval; this call PERSISTS the spec. Panels render NATIVELY at View time (Apache ECharts on the governed Cube layer) — there is no Superset import step, and every panel re-queries AS THE VIEWER so per-viewer row-level security is enforced live (a best-effort offline-mock only if Cube is unreachable). Same governed path as the Dashboards tab. Sharing it wider is the separate governed promote ladder (owner files request_promotion → a domain admin approves).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable id (to replace an existing one you own); auto-generated if omitted.' },
        name: { type: 'string', description: 'Dashboard name, e.g. "Sales Overview".' },
        view: { type: 'string', description: 'The Cube view (one gold dataset’s view) the charts bind to.' },
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
      if (!view) fail('create_dashboard needs a `view` (the gold dataset’s Cube view)', 400);
      const charts = (Array.isArray(args.charts) ? args.charts : []) as ChartSpec[];
      if (!charts.length) fail('a dashboard needs at least one chart on a governed metric', 400);
      const id = str(args.id).trim() || `dash_${slug(name)}_${rand()}`;
      // Scope the dashboard's governed view to the caller's domain. Tier-1 native dashboards
      // render at VIEW time (Apache ECharts on the governed Cube layer, per-viewer RLS) —
      // there is no Superset import step, so create_dashboard is persist-only (mirrors
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
          listGovernedDatasets().map((d) => [cubeViewName(d), registryDimensionMembers(d)]),
        );
        const views = narrowCubeMeta(members, await cubeMeta().catch(() => []), registryDims);
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
        if (v && v.served === false) {
          warnings.push(`View “${view}” is not currently served by Cube — the dataset's domain table may be missing or stale (re-promotion refreshes it). Panels render an honest warning until it is served.`);
        }
      } catch {
        /* the flagging is additive — never fail a successful create for it */
      }
      return { id: rec.id, tier: rec.tier, spec: rec.spec, ...(warnings.length ? { warnings } : {}) };
    },
  },
];

