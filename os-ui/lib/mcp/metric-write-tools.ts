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
  type PromotionRequest,
} from '@/lib/data/store';
import { runQualityChecks } from '@/lib/data/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@/lib/data';
import { queryRun } from '@/lib/infra/governed';
import { publishPromotionLive } from '@/lib/data/publish-server';
import { enqueue, getApproval, decide, listApprovals } from '@/lib/governance/approvals';
import { canBuildStage, canPassThrough, stageArtifact } from '@/lib/data/panels';
import { scaffoldCubeYaml } from '@/lib/data/metrics';
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
import { measureFromForm, measureMember, sameMeasure, type MetricForm, type GuidedFilter, type GuidedWindow } from '@/lib/metrics/model';
import type { MeasureType } from '@/lib/data/metrics';
import { buildMetric } from '@/lib/metrics/build/server';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';
import { getMetric } from '@/lib/metrics/store';
import { governMetric, canPromote as canPromoteMetric } from '@/lib/metrics/governance';
import { transition as transitionDataset } from '@/lib/data/store';
import { runSuggest } from '@/lib/metrics/suggest-server';

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
import { fromTiles, type ChartSpec } from '@/lib/dashboards/model';
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

// =============================== METRICS ======================================
export const metricWriteTools: McpTool[] = [
  {
    name: 'suggest_metrics',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Suggest 3–6 high-value candidate metrics grounded in the caller\'s STRATEGY (pillars), OPERATING MODEL, business PROCESSES (workflows) and the datasets they can see — the same governed context the Metrics tab "Suggest metrics" button uses. Read-only: proposes candidates, defines nothing. Each candidate carries name/description/why, an optional real pillarId + processId (workflow) it grounds on, a visible datasetId, a ready-to-define `form` (aggregation + real column + dimensions), and an optional `crossEntity` flag when its inputs span datasets (build a curated/joined dataset in Data first — never an invented join). Candidates whose dataset isn\'t visible or whose columns aren\'t real are dropped; `grounding` reports how much strategy/OM/process/data context actually informed the suggestions. Runs the reasoning model AS you; audited + cost-capped.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Optional free-text goal to steer the suggestions (e.g. "metrics for our checkout funnel"). Omit to propose the metrics this business most needs.' },
      },
      required: [],
      examples: [{}, { goal: 'metrics that show whether our onboarding is working' }],
    },
    call: async (user, args) => {
      const goal = str(args.goal).trim() || undefined;
      return await runSuggest(user, goal);
    },
  },
  {
    name: 'define_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Define a governed metric (also called: KPI, measure, indicator) on a dataset’s built GOLD version — the one definition of a number (Cube member). The dataset must already be a governed asset/product (promote it in Data first). Returns the canonical member + the generated Cube YAML. THE FULL MEASURE MODEL (same as the Metrics tab form — all optional, a plain call yields exactly {name,type,sql}): `aggregation` — count · count_distinct · count_distinct_approx (fast approximate distinct) · sum · avg · min · max · number (a DERIVED/ratio measure). `filter` — a FILTERED measure: aggregate only rows where {column op value} (op: equals|notEquals|gt|gte|lt|lte|set|notSet). `runningTotal` — a cumulative running total from the beginning of time. `rollingWindow` — a trailing time window (last N day|week|month|quarter|year), mutually exclusive with runningTotal. `ratio` — for aggregation "number", a derived measure numerator/denominator over two OTHER measures on the same cube. `format` — display format (currency|percent|number…). `drillMembers` — drill-down members exposed for exploration. `dimensions` — the slice-by columns this metric is meant to be explored by (a curation hint, persisted on the measure and rehydrated on edit). `timeDimension`+`granularity` are query-time (query_metric), not part of the definition. UPSERT: define is keyed by the metric name — re-defining a metric of the SAME name on the same dataset UPDATES it in place (no false "already defined"), a new name adds one.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Gold, governed (asset/product) dataset id.' },
        name: { type: 'string', description: 'Human metric name, e.g. "Revenue".' },
        aggregation: { type: 'string', enum: ['count', 'count_distinct', 'count_distinct_approx', 'sum', 'avg', 'min', 'max', 'number'], description: 'The aggregation. count/count_distinct/count_distinct_approx count rows; sum/avg/min/max aggregate a column; number is a derived (ratio) measure.' },
        column: { type: 'string', description: 'Gold column to aggregate (omit for count/count_distinct-of-rows and for number/ratio).' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Dimensions the metric can be sliced by.' },
        filter: {
          type: 'object',
          description: 'Optional FILTERED measure — aggregate only rows matching {column op value}.',
          properties: {
            column: { type: 'string' },
            operator: { type: 'string', enum: ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'set', 'notSet'] },
            value: { type: 'string', description: 'Compared value (unused for set/notSet).' },
          },
          required: ['column', 'operator'],
        },
        runningTotal: { type: 'boolean', description: 'Cumulative running total from the beginning of time (mutually exclusive with rollingWindow).' },
        rollingWindow: {
          type: 'object',
          description: 'Trailing time window — last `amount` `unit` (mutually exclusive with runningTotal).',
          properties: {
            amount: { type: 'number' },
            unit: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
          },
          required: ['amount', 'unit'],
        },
        ratio: {
          type: 'object',
          description: 'For aggregation "number": a derived measure = numerator / denominator, each an EXISTING measure member name on the same cube.',
          properties: {
            numerator: { type: 'string' },
            denominator: { type: 'string' },
          },
          required: ['numerator', 'denominator'],
        },
        format: { type: 'string', description: 'Display format — e.g. currency, percent, number.' },
        drillMembers: { type: 'array', items: { type: 'string' }, description: 'Drill-down members exposed for exploration.' },
      },
      required: ['datasetId', 'name', 'aggregation'],
      examples: [
        { datasetId: 'ds_ab12cd', name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['order_date', 'region'] },
        { datasetId: 'ds_ab12cd', name: 'Unique Customers', aggregation: 'count_distinct_approx', column: 'customer_id' },
        { datasetId: 'ds_ab12cd', name: 'Completed Orders', aggregation: 'count', filter: { column: 'status', operator: 'equals', value: 'completed' } },
        { datasetId: 'ds_ab12cd', name: 'Trailing 7d Revenue', aggregation: 'sum', column: 'net_amount', rollingWindow: { amount: 7, unit: 'day' }, format: 'currency' },
        { datasetId: 'ds_ab12cd', name: 'Conversion Rate', aggregation: 'number', ratio: { numerator: 'orders', denominator: 'sessions' }, format: 'percent' },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('define_metric needs a `datasetId`', 400);
      const name = str(args.name).trim();
      if (!name) fail('define_metric needs a `name`', 400);
      const form: MetricForm = {
        name,
        aggregation: str(args.aggregation) as MeasureType,
        column: str(args.column),
        dimensions: strArr(args.dimensions),
      };
      // The richer (optional) measure model — same guided controls as the tab form.
      const f = args.filter as Record<string, unknown> | undefined;
      if (f && str(f.column).trim()) {
        form.filter = { column: str(f.column), operator: str(f.operator) as GuidedFilter['operator'], value: str(f.value) };
      }
      if (args.runningTotal === true) form.runningTotal = true;
      const rw = args.rollingWindow as Record<string, unknown> | undefined;
      if (rw && typeof rw.amount === 'number' && str(rw.unit).trim()) {
        form.rollingWindow = { amount: rw.amount, unit: str(rw.unit) as GuidedWindow['unit'] };
      }
      const r = args.ratio as Record<string, unknown> | undefined;
      if (r && str(r.numerator).trim() && str(r.denominator).trim()) {
        form.ratio = { numerator: str(r.numerator), denominator: str(r.denominator) };
      }
      if (str(args.format).trim()) form.format = str(args.format).trim();
      if (Array.isArray(args.drillMembers)) form.drillMembers = strArr(args.drillMembers);

      const measure = measureFromForm(form); // MetricError → typed bad_request with the real reason
      const dataset = defineMeasure(datasetId, P(user), measure);
      const token = mcpToken(user);
      const build = await buildMetric(dataset, measure, token);
      return {
        datasetId,
        measure,
        member: build.member,
        cube: scaffoldCubeYaml(dataset),
        ...(build.pending ? { pending: true, note: 'Metric saved — live value appears within ~30 s as the query engine syncs.' } : {}),
      };
    },
  },
  {
    name: 'preview_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Preview the number a metric definition will produce, without persisting anything. Use this BEFORE define_metric to validate the number. An unsaved draft is computed via governed SQL (Trino, same row security) and labelled mode "live (sql)"; a saved+delivered measure resolves via governed Cube (mode "live"); offline degrades to "offline-mock". Returns rows + mode + the SQL. pending: true only when the shape (rolling window) is computable solely by the query engine after define_metric.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Gold, governed dataset id.' },
        name: { type: 'string', description: 'Proposed metric name.' },
        aggregation: { type: 'string', enum: ['count', 'count_distinct', 'count_distinct_approx', 'sum', 'avg', 'min', 'max', 'number'] },
        column: { type: 'string' },
        dimensions: { type: 'array', items: { type: 'string' } },
        timeDimension: { type: 'string', description: 'Time column to slice by.' },
        granularity: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
        limit: { type: 'number', description: 'Max rows (default 20, max 100).' },
      },
      required: ['datasetId', 'name', 'aggregation'],
      examples: [{ datasetId: 'ds_ab12cd', name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] }],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('preview_metric needs a datasetId', 400);
      const name = str(args.name).trim() || 'preview';
      const form: MetricForm = {
        name,
        aggregation: str(args.aggregation) as MeasureType,
        column: str(args.column),
        dimensions: strArr(args.dimensions),
      };
      const measure = measureFromForm(form);
      const dataset = getDataset(datasetId, P(user));
      const draft = { ...dataset, measures: [...dataset.measures.filter((m) => m.name !== measure.name), measure] };
      // UNSAVED draft → exploreMetric previews via governed SQL ('live (sql)') instead
      // of querying Cube for a member the sidecar hasn't (and can't have) delivered.
      const unsaved = !dataset.measures.some((m) => sameMeasure(m, measure));
      const token = mcpToken(user);
      const result = await exploreMetric(draft, measure, token, {
        dimensions: strArr(args.dimensions),
        timeDimension: str(args.timeDimension) || undefined,
        granularity: (str(args.granularity) as Granularity) || undefined,
        limit: typeof args.limit === 'number' ? Math.min(args.limit, 100) : 20,
      }, { unsaved });
      return { datasetId, measure, ...result };
    },
  },
  {
    name: 'promote_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Promote a metric one rung on the governance ladder (Personal→Domain or Domain→Company). A creator OWNER files a request (returned as { requested: true, approval }); a builder+ runs the consistency-gated govern flow directly. Mirrors the Metrics tab promote button.',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: 'Metric id: <datasetId>.<measureName>, e.g. "ds_ab12cd.revenue".' },
      },
      required: ['metricId'],
      examples: [{ metricId: 'ds_ab12cd.revenue' }],
    },
    call: async (user, args) => {
      const id = str(args.metricId).trim();
      if (!id) fail('promote_metric needs a metricId', 400);
      const record = getMetric(id, P(user));
      if (record.tier === 'marketplace') fail('This metric is already certified', 409);
      const transition: 'promote' | 'certify' = record.tier === 'personal' ? 'promote' : 'certify';
      // Creator owner at Personal → file a governed request
      if (transition === 'promote' && record.owner === user.id && !canPromoteMetric(user.role)) {
        const dup = listApprovals({ status: 'pending' }).find(
          (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'metric' && a.payload?.id === id,
        );
        if (dup) return { requested: true, approval: dup };
        const approval = enqueue({
          kind: 'artifact_promote',
          title: `Promote "${record.measure.name}" to a ${record.dataset.domain} domain metric`,
          detail: `${user.id} requests promoting the metric "${record.measure.name}" to a shared domain asset. A domain admin must approve.`,
          agent: user.id,
          domain: record.dataset.domain,
          requestedBy: user.id,
          tool: 'metric_promote',
          payload: { artifactKind: 'metric', id, name: record.measure.name },
          approverRole: 'domain_admin',
          scope: 'domain',
        });
        return { requested: true, approval };
      }
      // Approver path — consistency-gated govern flow
      const token = mcpToken(user);
      const resolve = async (): Promise<number | null> => {
        const r = await exploreMetric(record.dataset, record.measure, token, {});
        const total = r.rows.reduce((sum, row) => sum + Number(row[r.member] ?? 0), 0);
        return r.rows.length ? total : null;
      };
      const result = await governMetric(record, transition, { id: user.id, role: user.role }, resolve);
      if (!result.ok) fail(`${result.reason ?? 'governance gate failed'} (consistency: ${result.consistency.rows.filter((r) => !r.ok).map((r) => r.detail).join('; ')})`, 403);
      if (record.dataset.tier === 'dataset') fail('Promote the underlying dataset to a governed asset in the Data tab first', 409);
      transitionDataset(record.dataset.id, P(user), transition);
      return { item: { id, tier: result.record.tier } };
    },
  },
];

