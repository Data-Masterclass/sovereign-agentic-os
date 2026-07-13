/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session';
import type { McpTool, JsonSchema } from './server';
import { strategyWriteTools } from './strategy-tools';
import { marketplaceWriteTools } from './marketplace-tools';

// --- Governed lib functions (the EXACT same the UI + /api routes call) ---------
import {
  createDataset,
  buildVersion,
  setDocs as setDatasetDocs,
  requestPromotion as requestDatasetPromotion,
  getDataset,
  defineMeasure,
  buildGoldJoin as commitGoldJoin,
  addCheck,
  builtLayerFqn,
  type PromotionRequest,
} from '@/lib/data/store';
import { runQualityChecks } from '@/lib/data/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@/lib/data/dataset-schema';
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
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc, DatasetUpstream } from '@/lib/data/dataset-schema';
import { measureFromForm, measureMember, type MetricForm, type GuidedFilter, type GuidedWindow } from '@/lib/metrics/model';
import type { MeasureType } from '@/lib/data/metrics';

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
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
} from '@/lib/knowledge/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@/lib/knowledge/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
  type FilePromotionRequest,
} from '@/lib/files/store';
import { reindexFile } from '@/lib/files/pipeline-server';
import type { Sensitivity } from '@/lib/files/asset-schema';

import { saveDashboard, getDashboard } from '@/lib/dashboards/store';
import { fromTiles, type ChartSpec } from '@/lib/dashboards/model';

import {
  createBet,
  getBet,
  updateBet,
  addComponent,
  canEdit as canEditBet,
  type CreateBetInput,
} from '@/lib/bigbets/store';
import { deriveBetName, type BigBet, type ValueBasis } from '@/lib/bigbets/model';
import { registerLinkedArtifact, type LinkedArtifactInput } from '@/lib/bigbets/sources';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystem as getAgentSystem,
  getSystemForEdit,
  getSystemForRun,
} from '@/lib/agents/store';
import { isTemplateKey } from '@/lib/agents/templates';
import { buildSystem } from '@/lib/agents/build/server';

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
 */

type Principal = { id: string; domains: string[]; role: Role };
const P = (u: CurrentUser): Principal => ({ id: u.id, domains: u.domains, role: u.role });

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : [];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}
const rand = (): string => Math.random().toString(36).slice(2, 8);
const defaultGoLive = (): string => new Date(Date.now() + 56 * 86400000).toISOString().slice(0, 10);

function colDocs(v: unknown): ColumnDoc[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((c) => (typeof c === 'object' && c ? (c as Record<string, unknown>) : {}))
    .map((c) => ({ name: str(c.name).trim(), description: str(c.description) }))
    .filter((c) => c.name);
}

function mapSteps(v: unknown): WorkflowStep[] {
  if (!Array.isArray(v)) return [];
  const actors: ActorType[] = ['Human', 'Software', 'Agent'];
  return v
    .map((s) => (typeof s === 'object' && s ? (s as Record<string, unknown>) : {}))
    .map((s, i): WorkflowStep => {
      const actor = actors.includes(str(s.actor) as ActorType) ? (str(s.actor) as ActorType) : 'Human';
      return {
        id: slug(str(s.id) || str(s.title) || `step-${i + 1}`),
        title: str(s.title).trim() || `Step ${i + 1}`,
        actor,
        actor_name: str(s.actor_name).trim(),
        inputs: strArr(s.inputs),
        outputs: strArr(s.outputs),
        links: [],
        rules: [],
        tacit: str(s.tacit).trim(),
      };
    })
    .filter((s) => s.title);
}

function mapRules(v: unknown): WorkflowRule[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => (typeof r === 'object' && r ? (r as Record<string, unknown>) : { text: str(r) }))
    .map((r, i): WorkflowRule => ({
      id: slug(str(r.id) || `r${i + 1}`),
      text: str(r.text).trim(),
      hard: bool(r.hard),
      scope: r.scope === 'step' ? 'step' : 'workflow',
    }))
    .filter((r) => r.text);
}

function normFiles(args: Record<string, unknown>): { path: string; content: string }[] {
  const list = Array.isArray(args.files)
    ? (args.files as unknown[])
    : args.path !== undefined
      ? [{ path: args.path, content: args.content }]
      : [];
  return list
    .map((f) => (typeof f === 'object' && f ? (f as Record<string, unknown>) : {}))
    .map((f) => ({ path: str(f.path).trim(), content: str(f.content) }))
    .filter((f) => f.path);
}

// ================================ DATA ========================================
export const dataWriteTools: McpTool[] = [
  {
    name: 'create_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'Create a new PRIVATE dataset (a Bronze→Silver→Gold spine) in one of your domains — the same governed path as the Data tab’s “New dataset”. Starts Personal/owner-only; sharing is the separate governed `promote_dataset`. Optionally seed column docs. Idempotency: each call creates a distinct dataset.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human dataset name, e.g. "Orders".' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first domain.' },
        columns: {
          type: 'array',
          description: 'Optional column docs to seed (name + description).',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' } },
            required: ['name'],
          },
        },
      },
      required: ['name'],
      examples: [
        { name: 'Orders', domain: 'sales', columns: [{ name: 'order_id', description: 'Primary key' }, { name: 'net_amount', description: 'Order value in EUR' }] },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_dataset needs a `name` string', 400);
      const p = P(user);
      const d = createDataset(p, { name, domain: str(args.domain) || undefined });
      const cols = colDocs(args.columns);
      return cols.length ? setDatasetDocs(d.id, p, { columns: cols }) : d;
    },
  },
  {
    name: 'add_dataset_version',
    tab: 'data',
    minRole: 'creator',
    description:
      'Commit one medallion version (bronze→silver→gold) of a dataset you can edit — the guided panel’s “Confirm”. Pass an authored dbt-SQL `body` for silver/gold, or `passThrough:true` to carry the prior layer forward. The prior layer must exist first. Honesty contract: silver/gold register ONLY after a real materialization — a pass-through runs a governed CTAS copy of the prior layer, an authored commit is probed against its physical table (build it first, e.g. via transform_silver); a ✗ registers nothing. Offline it degrades to an honestly-labelled offline-mock.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Target dataset id (from create_dataset).' },
        layer: { type: 'string', enum: ['bronze', 'silver', 'gold'], description: 'Medallion layer to build.' },
        body: { type: 'string', description: 'Authored dbt SQL (+ tests) for silver/gold. Ignored for passThrough.' },
        quality: { type: 'string', description: 'Optional quality label for the built version.' },
        passThrough: { type: 'boolean', description: 'Carry the prior layer forward unchanged (silver/gold only).' },
      },
      required: ['datasetId', 'layer'],
      examples: [
        { datasetId: 'ds_ab12cd', layer: 'bronze' },
        { datasetId: 'ds_ab12cd', layer: 'silver', body: 'select order_id, net_amount from {{ ref("orders_bronze") }}' },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('add_dataset_version needs a `datasetId`', 400);
      const layer = str(args.layer) as Layer;
      if (!['bronze', 'silver', 'gold'].includes(layer)) fail('layer must be bronze|silver|gold', 400);
      const p = P(user);
      const current = getDataset(datasetId, p);
      if (!canBuildStage(current.versions, layer)) fail(`bring in the prior layer before building ${layer}`, 400);
      const passThrough = bool(args.passThrough);
      if (passThrough && !canPassThrough(layer)) fail('Bronze is the entry point — nothing to pass through', 400);
      // The ONE honest commit path (shared with the version route): silver/gold are
      // registered ONLY after the materialize-or-probe build report is ✓.
      const outcome = await commitLayerVersion(current, layer, p, {
        passThrough,
        quality: (str(args.quality) as Quality) || undefined,
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      if (!outcome.ok || !outcome.dataset) {
        fail(`${layer} commit did not pass${outcome.build ? ` (${outcome.build.mode})` : ''}: ${outcome.error ?? 'apply/verify failed'} — nothing was registered`, 502);
      }
      return outcome.dataset;
    },
  },
  {
    name: 'document_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'Write the promotion-gate documentation (description + column docs) onto a dataset you can edit — the Data tab’s “Document” form. Idempotent: re-running overwrites the docs.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Target dataset id.' },
        description: { type: 'string', description: 'What this dataset is and how to use it.' },
        columns: {
          type: 'array',
          description: 'Column docs (name + description).',
          items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] },
        },
      },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd', description: 'One row per order.', columns: [{ name: 'net_amount', description: 'EUR value' }] }],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('document_dataset needs a `datasetId`', 400);
      const cols = colDocs(args.columns);
      return setDatasetDocs(datasetId, P(user), {
        description: typeof args.description === 'string' ? args.description : undefined,
        columns: cols.length ? cols : undefined,
      });
    },
  },
  {
    name: 'ingest_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'Ingest inline CSV/JSON text as the PHYSICAL Bronze of a dataset you can edit — the same pipeline as the Data tab’s "Upload a file": your bytes land in MinIO under uploads/<your-id>/, the data-runner writes the real iceberg.personal_<you>.bronze_<slug> table, and the Bronze version is registered ONLY when apply + a governed verify SELECT both pass (no dot without a queryable landing; offline it degrades to an honestly-labelled offline-mock). Purpose: make the physical golden path AI-drivable end-to-end. Before: create_dataset (or get_dataset to reuse). After: profile_dataset to explore it, then transform_silver. Governance: runs AS YOU — the object key is forced under your own uploads/ prefix from the session identity, and the verify probe is OPA-masked to you. Limit: ~2 MB of in-band text; bigger files → the UI upload (same pipeline, streaming multipart).',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Target dataset id (from create_dataset / list_datasets).' },
        content: { type: 'string', description: 'The raw CSV (or JSON) text to ingest — max ~2 MB in-band.' },
        fileName: { type: 'string', description: 'File name for the object store (default upload.csv; the extension drives parsing).' },
      },
      required: ['datasetId', 'content'],
      examples: [
        { datasetId: 'ds_ab12cd', fileName: 'orders.csv', content: 'order_id,net_amount\n1001,250.00\n1002,90.50' },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('ingest_dataset needs a `datasetId`', 400);
      const content = str(args.content);
      if (!content.trim()) fail('ingest_dataset needs non-empty `content` (CSV/JSON text)', 400);
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > INGEST_MAX_BYTES) {
        fail(
          `content is ${(bytes / 1048576).toFixed(1)} MB — the MCP in-band limit is ${INGEST_MAX_BYTES / 1048576} MB. ` +
            'Upload larger files through the Data tab UI (same governed pipeline, streaming multipart).',
          400,
        );
      }
      const fileName = str(args.fileName).trim() || 'upload.csv';
      const r = await ingestAndRegisterBronze(P(user), datasetId, fileName, Buffer.from(content, 'utf8'));
      if (!r.ok) {
        // Verify did not pass → Bronze is NOT registered; surface the real reason.
        fail(`ingest verify failed: ${r.report.error ?? r.report.detail}`, 502);
      }
      return {
        ok: true,
        mode: r.report.mode,
        table: r.report.table,
        rowCount: r.report.rowCount,
        columns: r.report.columns,
        preview: r.report.preview,
        bronzeRegistered: true,
        datasetId,
      };
    },
  },
  {
    name: 'transform_silver',
    tab: 'data',
    minRole: 'creator',
    description:
      'Clean a dataset’s Bronze into its physical SILVER via guided ops compiled into ONE governed CTAS — the same compiler + Build adapter as the Data tab’s Transform panel. Ops: rename {column,to} · cast {column,type: varchar|integer|bigint|double|boolean|date|timestamp} · trim {column} · normalize {column} (lower+trim) · drop {column} · filter {column, op: =|<>|>|>=|<|<=|not_null|not_blank, value?} · dedupe {keys[]} (empty keys ⇒ DISTINCT). Purpose: step 3 of the physical Data golden path. Before: ingest_dataset (Bronze must be built); profile_dataset to see the columns. After: build_gold_join, or add_dataset_version(gold). Governance: the SQL is compiled server-side from your ops (a client can never send raw SQL), the CTAS targets YOUR OWN schema and executes AS YOU — Trino→OPA masks every read — and the Silver version is registered ONLY on a ✓ apply+verify (an honest ✗ registers nothing).',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Target dataset id (Bronze must be built).' },
        columns: { type: 'array', items: { type: 'string' }, description: 'The SOURCE Bronze column names to project (from profile_dataset).' },
        ops: {
          type: 'array',
          description: 'Guided cleaning ops (see the tool description for the op kinds). Empty = plain projection.',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['rename', 'cast', 'trim', 'normalize', 'drop', 'filter', 'dedupe'] } }, required: ['kind'] },
        },
      },
      required: ['datasetId', 'columns'],
      examples: [
        {
          datasetId: 'ds_ab12cd',
          columns: ['order_id', 'net_amount', 'region'],
          ops: [
            { kind: 'cast', column: 'net_amount', type: 'double' },
            { kind: 'filter', column: 'order_id', op: 'not_null' },
            { kind: 'dedupe', keys: ['order_id'] },
          ],
        },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('transform_silver needs a `datasetId`', 400);
      const columns = strArr(args.columns);
      const ops = (Array.isArray(args.ops) ? args.ops : []) as TransformOp[];
      const dataset = getDataset(datasetId, P(user)); // view-scope guard (403/404)
      if (!canBuildStage(dataset.versions, 'silver')) {
        fail('Bring in the Bronze version before cleaning it (run ingest_dataset first)', 400);
      }
      const identity = executeIdentity(user);
      // Compile server-side (TransformError → typed bad_request with the real reason).
      const plan = silverPlan(dataset, identity, columns, ops);
      // Personal-lane builds run under the UID so Trino→OPA recognises the caller as
      // the personal_<uid> owner (same rule as the transform route).
      if (plan.schema.startsWith('personal_')) identity.principal = user.id;
      const build = await buildStage(dataset, 'silver', identity.principal, { transformSql: plan.sql, identity, targetFqn: plan.target });
      if (!build.ok) {
        const failed = build.rows.find((r) => r.status === 'fail');
        fail(`Silver build did not pass (${build.mode}): ${failed?.error ?? 'apply/verify failed'} — nothing was registered`, 502);
      }
      // ✓ only: register the Silver version + persist the compiled SQL as its artifact.
      const updated = buildVersion(datasetId, P(user), 'silver', {
        quality: 'unknown',
        artifact: stageArtifact(dataset.name, 'silver'),
        body: plan.sql,
      });
      return { ok: true, mode: build.mode, sql: plan.sql, target: plan.target, silverRegistered: true, dots: { bronze: updated.versions.bronze.built, silver: updated.versions.silver.built, gold: updated.versions.gold.built } };
    },
  },
  {
    name: 'build_gold_join',
    tab: 'data',
    minRole: 'creator',
    description:
      'Build a dataset’s physical GOLD by JOINING its Silver with other governed datasets you may read — the Data tab’s stage-4 reuse, compiled into ONE governed CTAS. You pass dataset IDS to join (never table names — each is re-resolved through the canView guard), the join keys, projected dimensions and derived measures (sum/avg/count/count_distinct/min/max, or count(*) with agg "count" and no col). Column refs are {ref, column} where ref 0 = your Silver base and 1..n = the joined datasets in order. KEY MAPPING / RECONCILE: same-name keys auto-match with no extra config; when the two sides differ, set the join key’s optional `adapt` to reconcile them symmetrically (both sides wrapped): `{mode:"text"}` normalizes to lower(trim(cast … as varchar)) so keys differing only by case/whitespace/format line up, `{mode:"cast",type}` coerces both sides to one Trino type (varchar|integer|bigint|double|boolean|date|timestamp) — e.g. an id stored as varchar on one side, integer on the other. Purpose: the reuse step of the physical Data golden path — the measures recorded here feed define_metric after promotion. Before: transform_silver (Silver must be built); pick join partners from list_datasets (governed asset/product tiers with a built table). After: document_dataset → request_promotion → define_metric. Governance: the CTAS targets YOUR OWN schema and executes AS YOU (Trino→OPA masks every joined read); a non-visible pick is a typed forbidden; Gold + lineage + measures are recorded ONLY on a ✓ apply+verify.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'The base dataset (its Silver must be built).' },
        picks: {
          type: 'array',
          description: 'Datasets to join (1..n).',
          items: {
            type: 'object',
            properties: {
              datasetId: { type: 'string', description: 'A governed dataset id you can READ.' },
              type: { type: 'string', enum: ['inner', 'left'], description: 'Join type (default inner).' },
              on: {
                type: 'array',
                description: 'Equi-join keys: an earlier table’s column = this table’s column.',
                items: {
                  type: 'object',
                  properties: {
                    left: { type: 'object', properties: { ref: { type: 'number' }, column: { type: 'string' } }, required: ['ref', 'column'] },
                    right: { type: 'string' },
                    adapt: {
                      type: 'object',
                      description: 'Optional key reconciliation when the two sides don’t match verbatim (auto-matched same-name keys need none). Applied symmetrically to BOTH sides. `text` normalizes to lower(trim(cast … as varchar)) (case/whitespace/format); `cast` coerces both sides to one Trino type.',
                      properties: {
                        mode: { type: 'string', enum: ['text', 'cast'] },
                        type: { type: 'string', enum: [...CAST_TYPES], description: 'Required for mode "cast": the shared Trino type both sides are cast to.' },
                      },
                      required: ['mode'],
                    },
                  },
                  required: ['left', 'right'],
                },
              },
            },
            required: ['datasetId', 'on'],
          },
        },
        dimensions: {
          type: 'array',
          description: 'Projected columns: {col: {ref, column}, as?}. Grouped when measures are present.',
          items: { type: 'object', properties: { col: { type: 'object' }, as: { type: 'string' } }, required: ['col'] },
        },
        measures: {
          type: 'array',
          description: 'Derived measures: {name, agg} for count(*), {name, agg, col} for a column aggregate, or {name, agg, left, op, right} for an expression.',
          items: { type: 'object', properties: { name: { type: 'string' }, agg: { type: 'string', enum: ['sum', 'avg', 'count', 'count_distinct', 'min', 'max'] } }, required: ['name', 'agg'] },
        },
      },
      required: ['datasetId', 'picks'],
      examples: [
        {
          datasetId: 'ds_ab12cd',
          picks: [{ datasetId: 'ds_customers', type: 'left', on: [{ left: { ref: 0, column: 'customer_id' }, right: 'customer_id' }] }],
          dimensions: [{ col: { ref: 1, column: 'region' } }],
          measures: [{ name: 'revenue', agg: 'sum', col: { ref: 0, column: 'net_amount' } }],
        },
        {
          datasetId: 'ds_ab12cd',
          picks: [
            {
              datasetId: 'ds_customers',
              type: 'left',
              on: [{ left: { ref: 0, column: 'cust_code' }, right: 'customer_id', adapt: { mode: 'text' } }],
            },
          ],
          dimensions: [{ col: { ref: 1, column: 'region' } }],
          measures: [{ name: 'revenue', agg: 'sum', col: { ref: 0, column: 'net_amount' } }],
        },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('build_gold_join needs a `datasetId`', 400);
      const p = P(user);
      const dataset = getDataset(datasetId, p); // view-scope guard on the base
      if (!canBuildStage(dataset.versions, 'gold')) {
        fail('Bring in the Silver version before joining it (run transform_silver first)', 400);
      }
      const rawPicks = Array.isArray(args.picks) ? (args.picks as Record<string, unknown>[]) : [];
      if (rawPicks.length === 0) fail('Pick at least one dataset to join (`picks`)', 400);

      const identity = executeIdentity(user);
      // Resolve each pick through the canView guard — a non-visible id → typed 403/404.
      const joins: ResolvedJoin[] = [];
      const upstreams: DatasetUpstream[] = [];
      for (const pick of rawPicks) {
        const up = getDataset(str(pick?.datasetId).trim(), p); // throws 403/404
        const fqn = assetTarget(up);
        const type: JoinType = pick?.type === 'left' ? 'left' : 'inner';
        const on = Array.isArray(pick?.on) ? (pick.on as ResolvedJoin['on']) : [];
        joins.push({ table: fqn, type, on });
        upstreams.push({ datasetId: up.id, name: up.name, fqn, joinType: type });
      }
      const dimensions = (Array.isArray(args.dimensions) ? args.dimensions : []) as GoldDimension[];
      const measures = (Array.isArray(args.measures) ? args.measures : []) as GoldMeasure[];

      // Compile server-side (TransformError → typed bad_request with the real reason).
      const plan = goldJoinPlan(dataset, identity, joins, dimensions, measures);
      if (plan.schema.startsWith('personal_')) identity.principal = user.id;
      const build = await buildStage(dataset, 'gold', identity.principal, { transformSql: plan.sql, identity, targetFqn: plan.target });
      if (!build.ok) {
        const failed = build.rows.find((r) => r.status === 'fail');
        fail(`Gold join did not pass (${build.mode}): ${failed?.error ?? 'apply/verify failed'} — nothing was recorded`, 502);
      }
      // ✓ only: record the Gold version, the measures (feed the Cube scaffold at
      // promotion) and the multi-upstream lineage edges (the reuse).
      const updated = commitGoldJoin(datasetId, p, {
        measures: measures.map(goldMeasureToCube),
        upstreams,
        artifact: stageArtifact(dataset.name, 'gold'),
        body: plan.sql,
      });
      return {
        ok: true,
        mode: build.mode,
        sql: plan.sql,
        target: plan.target,
        goldRegistered: true,
        measures: updated.measures,
        upstreams: updated.upstreams,
      };
    },
  },
  {
    name: 'define_quality_rules',
    tab: 'data',
    minRole: 'creator',
    description:
      'Add one or more data-quality RULES to a dataset you can edit — the Data tab’s "Data quality" editor. Each rule is executable: not_null(column), not_blank(column), unique(column), accepted_values(column, values[]), range(column, min?, max?). Rules are stored on the dataset.yaml spine (versioned + discoverable) and RUN via run_quality_checks. Before: get_dataset (to see the real column names). After: run_quality_checks to get a real pass/fail. Governance: Creator+ on a dataset you own (or domain Admin); each rule needs a column. Idempotent-ish: re-running appends rules.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Target dataset id (from list_datasets / get_dataset).' },
        rules: {
          type: 'array',
          description: 'The rules to add.',
          items: {
            type: 'object',
            properties: {
              rule: { type: 'string', enum: [...DATA_CHECK_RULES], description: 'The rule kind.' },
              column: { type: 'string', description: 'The column the rule applies to.' },
              values: { type: 'array', items: { type: 'string' }, description: 'accepted_values: the allowed set.' },
              min: { type: 'number', description: 'range: inclusive lower bound (optional).' },
              max: { type: 'number', description: 'range: inclusive upper bound (optional).' },
            },
            required: ['rule', 'column'],
          },
        },
      },
      required: ['datasetId', 'rules'],
      examples: [
        { datasetId: 'ds_ab12cd', rules: [{ rule: 'not_null', column: 'order_id' }, { rule: 'range', column: 'net_amount', min: 0 }, { rule: 'accepted_values', column: 'status', values: ['open', 'shipped', 'closed'] }] },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('define_quality_rules needs a `datasetId`', 400);
      const rulesIn = Array.isArray(args.rules) ? args.rules : [];
      if (rulesIn.length === 0) fail('define_quality_rules needs at least one rule', 400);
      const p = P(user);
      let dataset = getDataset(datasetId, p); // canView/canEdit re-gated in addCheck
      for (const raw of rulesIn) {
        const r = (raw ?? {}) as Record<string, unknown>;
        const rule = str(r.rule) as DataCheckRule;
        if (!(DATA_CHECK_RULES as string[]).includes(rule)) fail(`unknown rule '${str(r.rule)}' (${DATA_CHECK_RULES.join('|')})`, 400);
        const column = str(r.column).trim();
        if (!column) fail(`${rule} needs a column`, 400);
        dataset = addCheck(datasetId, p, {
          name: `${rule}(${column})`,
          rule,
          column,
          values: Array.isArray(r.values) ? r.values.map((x) => str(x)) : undefined,
          min: typeof r.min === 'number' ? r.min : undefined,
          max: typeof r.max === 'number' ? r.max : undefined,
        });
      }
      return { datasetId, checks: dataset.checks ?? [] };
    },
  },
  {
    name: 'run_quality_checks',
    tab: 'data',
    minRole: 'creator',
    description:
      'Run a dataset’s data-quality rules and READ the result — the "Run checks" button. Each structured rule is compiled to a governed COUNT-of-violations SQL and executed through the SAME governed query path AS THE OWNER (a private dataset’s personal_<uid> table is read as its owner, OPA-governed), producing a REAL pass/fail per rule plus an aggregate badge (passing | failing | unknown). Honesty: a rule that can’t run (nothing materialised yet, or a free-text intention) is reported "not_run", NEVER a fake pass. Before: define_quality_rules (+ a built layer to check). Governance: Creator+ on a dataset you can see; read-only.',
    inputSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string', description: 'Dataset id whose rules to run (from get_dataset).' } },
      required: ['datasetId'],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('run_quality_checks needs a `datasetId`', 400);
      const p = P(user);
      const dataset = getDataset(datasetId, p); // canView gate
      const resolved = builtLayerFqn(dataset, p); // { fqn, principal } | null
      const report = await runQualityChecks(dataset.checks ?? [], {
        fqn: resolved?.fqn ?? null,
        queryFn: (sql) => queryRun(sql, resolved?.principal),
      });
      return { datasetId, name: dataset.name, ...report };
    },
  },
];

/** MCP in-band ingest cap (~2 MB) — bigger files go through the UI's streaming upload. */
const INGEST_MAX_BYTES = 2 * 1024 * 1024;

/** The governed WRITE identity, derived from the SESSION user (never the args). */
function executeIdentity(u: CurrentUser): ExecuteIdentity {
  return { principal: u.domains[0] ?? u.id, uid: u.id, domains: u.domains, role: u.role };
}

// ============================== KNOWLEDGE ======================================
export const knowledgeWriteTools: McpTool[] = [
  {
    name: 'author_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Author a Personal (draft) knowledge workflow — the operating manual for a task: an optional markdown body, ordered `steps` (each with an actor and optional per-step `tacit` note), workflow `rules`, and an optional workflow-level `tacit` string (the TACIT.md companion — unstructured know-how that resists formalization: the gotchas, the "why", the tribal memory). Same governed store as the Knowledge tab. Publish it later with `publish_knowledge`.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Workflow title, e.g. "Refund handling".' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        markdown: { type: 'string', description: 'Optional free markdown body (context/prose).' },
        steps: {
          type: 'array',
          description: 'Ordered steps.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              actor: { type: 'string', enum: ['Human', 'Software', 'Agent'] },
              actor_name: { type: 'string' },
              inputs: { type: 'array', items: { type: 'string' } },
              outputs: { type: 'array', items: { type: 'string' } },
              tacit: {
                type: 'string',
                description:
                  'Per-step tacit note — the inline know-how for this step: gotchas, edge cases, undocumented nuances. Stored as a `> tacit:` blockquote in the workflow.md and indexed as a separate retrieval unit.',
              },
            },
            required: ['title'],
          },
        },
        rules: {
          type: 'array',
          description: 'Workflow decision rules.',
          items: { type: 'object', properties: { text: { type: 'string' }, hard: { type: 'boolean' } }, required: ['text'] },
        },
        tacit: {
          type: 'string',
          description:
            'Workflow-level tacit knowledge (the sibling TACIT.md). Use this for unstructured know-how that resists formalization — the gotchas, the "why behind the why", institutional memory, cultural nuances that don\'t fit into steps or rules. Markdown is fine; headings split it into separately-retrievable chunks. Per-step inline notes go in `steps[].tacit` instead.',
        },
      },
      required: ['title'],
      examples: [
        {
          title: 'Refund handling',
          domain: 'support',
          steps: [
            { title: 'Verify order', actor: 'Human', outputs: ['Verified order'], tacit: 'Check section 4 — the date field is frequently missed by new agents.' },
            { title: 'Issue refund', actor: 'Software', inputs: ['Verified order'] },
          ],
          rules: [{ text: 'Refunds over 500 EUR need a manager', hard: true }],
          tacit: '## Edge cases\nHigh-value refunds (> 1 000 EUR) route to the finance team even on weekends — the on-call number is in the finance Notion.\n\n## Cultural note\nThe support team uses "RT" as shorthand for "refund ticket" in Slack.',
        },
      ],
    },
    call: async (user, args) => {
      const title = str(args.title).trim();
      if (!title) fail('author_knowledge needs a `title`', 400);
      const p = P(user);
      const rec = createWorkflow(p, { title, domain: str(args.domain) || undefined });
      const body = str(args.markdown);
      const steps = mapSteps(args.steps);
      const rules = mapRules(args.rules);
      if (body || steps.length || rules.length) {
        const view = getWorkflow(rec.id, p);
        const w: Workflow = { ...view.workflow, steps: steps.length ? steps : view.workflow.steps, rules: rules.length ? rules : view.workflow.rules };
        // serializeWorkflow emits frontmatter + step blocks (including > tacit: blockquotes
        // for any step with a tacit note); splice the prose body back in right after the
        // frontmatter so it round-trips through the store.
        let md = serializeWorkflow(w);
        if (body) md = md.replace(/^(---\n[\s\S]*?\n---\n\n)/, `$1${body}\n\n`);
        updateWorkflow(rec.id, p, { md });
      }
      // Workflow-level tacit doc (sibling TACIT.md) — stored separately from the
      // workflow.md so it can be versioned, compressed, and chunked independently.
      const tacit = str(args.tacit).trim();
      if (tacit) updateTacit(rec.id, p, tacit);
      return { id: rec.id, title: rec.title, domain: rec.domain, status: rec.status, visibility: rec.visibility };
    },
  },
  {
    name: 'publish_knowledge',
    tab: 'knowledge',
    minRole: 'domain_admin',
    description:
      'Publish a draft workflow Personal → Shared (draft→live) and re-index it for retrieval. Builder+ only (the creator lockdown). This is the compat "approve half" of the ladder: the flip runs THROUGH the governance effect seam (no direct publish back door). Idempotency: publishing an already-live workflow returns a `conflict`.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'Draft workflow id to publish.' } },
      required: ['workflowId'],
      examples: [{ workflowId: 'wf_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('publish_knowledge needs a `workflowId`', 400);
      const p = P(user);
      // Route the flip through the ONE effect seam (never publishWorkflow directly).
      // Intent is PUBLISH (rung 1): a mismatch (already-Shared workflow) is a typed
      // conflict, not a silent certify-to-marketplace.
      await promoteThroughSeam('knowledge', id, user, { rung: 'promote' });
      const rec = getWorkflow(id, p);
      try {
        await indexWorkflow(rec.workflow, { owner: rec.owner, tacit: rec.tacit, updatedAt: rec.updatedAt });
        await indexDomain(getDomainKnowledge(rec.domain));
      } catch {
        /* indexing is best-effort; publish already succeeded */
      }
      return { id: rec.id, status: rec.status, visibility: rec.visibility, publishedBy: rec.publishedBy };
    },
  },
  {
    name: 'index_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Re-run the indexing pipeline (unit-chunk → embed → hybrid index) for a workflow you can see + its domain card, so `search_knowledge` returns it. Idempotent — safe to re-run.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'Workflow id to (re)index.' } },
      required: ['workflowId'],
      examples: [{ workflowId: 'wf_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('index_knowledge needs a `workflowId`', 400);
      const p = P(user);
      const view = getWorkflow(id, p);
      const workflow = await indexWorkflow(view.workflow, { owner: view.owner, tacit: view.tacit, updatedAt: view.updatedAt });
      const domain = await indexDomain(getDomainKnowledge(view.domain));
      return { workflow, domain };
    },
  },
  {
    name: 'retire_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'RETIRE a knowledge workflow you can edit — the Knowledge tab’s lifecycle: `archive` (the default: reversible soft-hide, retains the record + history, unarchive with author_knowledge’s sibling flow) or `delete` (PHYSICAL + irreversible: removes the record, its version history, and purges its indexed units from OpenSearch + the offline mirror so it stops being retrievable). Same governed store the Knowledge tab + `/api/knowledge/workflows/[id]` call. LINEAGE-AWARE: blocked with a typed 409 if any App or Agent system still consumes it (never orphan a live dependency) — remove those uses first. Role gate (edit scope, re-checked in-lib): the OWNER may retire their own Personal/unshared workflow; a SHARED/domain workflow needs a same-domain Builder+ (the Knowledge edit gate). Physical `delete` additionally refuses a still-published (`live`) workflow — archive/unpublish it first (mirrors the store). Idempotency: retiring a missing workflow is a typed not_found.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The knowledge workflow id to retire.' },
        action: {
          type: 'string',
          enum: ['archive', 'delete'],
          description: 'archive = reversible soft-hide (default); delete = physical, irreversible removal + index purge.',
        },
      },
      required: ['workflowId'],
      examples: [
        { workflowId: 'wf_ab12cd' },
        { workflowId: 'wf_ab12cd', action: 'delete' },
      ],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('retire_knowledge needs a `workflowId`', 400);
      const action = str(args.action).trim() || 'archive';
      if (action !== 'archive' && action !== 'delete') {
        fail("retire_knowledge `action` must be 'archive' or 'delete'", 400);
      }
      const p = P(user);
      // View-scope + existence guard first (typed 403/404) so a lineage/role message
      // never leaks a workflow the caller can't even see.
      const view = getWorkflow(id, p);
      // LINEAGE GUARD (mirrors the app-delete dependentsOf check): refuse to orphan a
      // live consumer. Runs for BOTH archive and delete — retiring an in-use workflow,
      // reversibly or not, breaks the consumers' context handover.
      const consumers = await knowledgeConsumers(id, p);
      if (consumers.length > 0) {
        const names = consumers.map((c) => `${c.by} (${c.kind})`).join(', ');
        fail(`retire blocked — this workflow is still consumed by: ${names}. Remove those uses first.`, 409);
      }
      if (action === 'archive') {
        const rec = archiveWorkflow(id, p); // edit-gated in-lib (owner or same-domain Builder+)
        return { id: rec.id, title: rec.title, action: 'archive', archived: rec.archived, reversible: true };
      }
      // PHYSICAL delete: edit-gated + refuses a live workflow in-lib. On success, purge
      // the indexed units so a deleted workflow stops being retrievable (best-effort +
      // honest — the record is already gone; report if the index purge couldn't run).
      deleteWorkflow(id, p);
      const indexPurged = await purgeKnowledgeUnits(id);
      return { id, title: view.title, action: 'delete', deleted: true, indexPurged, reversible: false };
    },
  },
];

// ================================ FILES =======================================
export const fileWriteTools: McpTool[] = [
  {
    name: 'upload_file',
    tab: 'files',
    minRole: 'creator',
    description:
      'Upload a governed file (private object-store file at v1) with optional extracted `text` (indexed for search), folder, tags, description and sensitivity. Same path as the Files tab upload. `restricted` sensitivity is stored-but-not-indexed. A `description` + ≥1 tag make it eligible for `promote_file`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name, e.g. "refund-policy.md".' },
        folder: { type: 'string', description: 'Optional folder path.' },
        text: { type: 'string', description: 'Extracted/preview text (chunked + embedded for search).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (≥1 needed to promote).' },
        description: { type: 'string', description: 'What this file is (needed to promote it).' },
        sensitivity: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'], description: 'Governs indexing (restricted ⇒ not indexed).' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
      },
      required: ['name'],
      examples: [{ name: 'refund-policy.md', folder: 'policies', text: 'Refunds are processed within 5 days.', tags: ['policy'], description: 'Customer refund policy', sensitivity: 'internal' }],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('upload_file needs a `name`', 400);
      const p = P(user);
      const tags = strArr(args.tags);
      const asset = createFile(p, {
        name,
        folder: str(args.folder) || undefined,
        text: typeof args.text === 'string' ? args.text : undefined,
        tags,
        sensitivity: (str(args.sensitivity) as Sensitivity) || undefined,
        domain: str(args.domain) || undefined,
      });
      const description = str(args.description);
      const documented = description ? setFileDocs(asset.id, p, { description, tags }) : asset;
      try {
        await reindexFile(documented, str(args.text));
      } catch {
        /* indexing is best-effort; the upload already succeeded */
      }
      return documented;
    },
  },
];

// ============================== PROMOTION (split) =============================
// The GOVERNED separation-of-duties seam, matching the UI: a creator FILES a
// promotion request (enqueued into the shared approvals queue); a Builder/Admin
// in the domain APPLIES it. One tool pair spans datasets + files (extraTabs), so
// both the data and files per-tab lenses expose it.
export const promotionTools: McpTool[] = [
  {
    name: 'request_promotion',
    tab: 'data',
    extraTabs: ['files'],
    minRole: 'creator',
    description:
      'FILE a rung-1 promotion request (Personal → a governed DOMAIN asset) for ANY ownable artifact: a dataset, file, knowledge workflow, connection, dashboard, model, app or agent system. Path: the promote step of every tab’s golden path — the ONE governed ladder. Before: create + document the artifact. After: a Builder/Admin in the domain runs `decide_approval` (or `approve_promotion` for dataset/file). Governance: OWNER-ONLY trigger — edit rights are not enough; it does NOT promote, it enqueues the governed request and returns the pending handle. Certification (Domain→Marketplace) is the separate `request_certification`. Idempotency: filing while a request is pending returns the existing handle.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['dataset', 'file', 'knowledge', 'connection', 'dashboard', 'model', 'app', 'agent_system'], description: 'What to promote (you must OWN it).' },
        id: { type: 'string', description: 'The artifact id you own and have documented.' },
        visibility: { type: 'string', description: 'Requested asset visibility (dataset/file only; default domain).' },
        grants: { type: 'array', description: 'Optional explicit policy grants (dataset/file only; else a domain read grant).' },
      },
      required: ['kind', 'id'],
      examples: [{ kind: 'dataset', id: 'ds_ab12cd', visibility: 'domain' }, { kind: 'knowledge', id: 'wf_ab12cd' }, { kind: 'connection', id: 'conn_ab12cd' }],
    },
    call: async (user, args) => {
      const kind = str(args.kind).trim();
      const id = str(args.id).trim();
      if (!id) fail('request_promotion needs an `id`', 400);

      // The formerly-DIRECT ladder kinds (knowledge/connection/dashboard/model/app/
      // agent_system) file through the ONE ladder seam — owner-only, effect applied
      // on approval.
      if (isLadderKind(kind)) {
        const approval = await fileArtifactPromotion(kind as LadderKind, id, user);
        return pendingHandle(approval, { artifactKind: kind, target: approval.detail, domain: approval.domain });
      }
      if (kind !== 'dataset' && kind !== 'file') {
        fail('request_promotion needs `kind` = dataset | file | knowledge | connection | dashboard | model | app | agent_system', 400);
      }
      const p = P(user);
      const opts = {
        visibility: (str(args.visibility) as DataVisibility) || undefined,
        grants: (args.grants as Grant[]) || undefined,
      };
      const approvalKind = kind === 'dataset' ? 'dataset_promote' : 'file_promote';
      // Don't file a duplicate pending request for the same asset.
      const existing = enqueueDedup(approvalKind, id);
      if (existing) return pendingHandle(existing, { artifactKind: kind, target: existing.detail, domain: existing.domain, already: true });

      if (kind === 'dataset') {
        const req: PromotionRequest = requestDatasetPromotion(id, p, opts);
        const approval = enqueue({
          kind: 'dataset_promote',
          title: `Promote “${req.datasetName}” to a data asset`,
          detail: `${user.id} requests promoting ${req.datasetName} into ${req.target} (visibility: ${req.visibility}). A domain admin must approve.`,
          agent: user.id,
          domain: req.domain,
          requestedBy: user.id,
          tool: 'data_promote',
          payload: req as unknown as Record<string, unknown>,
          approverRole: 'domain_admin',
        });
        return pendingHandle(approval, { artifactKind: kind, target: req.target, domain: req.domain });
      }
      const req: FilePromotionRequest = requestFilePromotion(id, p, opts);
      const approval = enqueue({
        kind: 'file_promote',
        title: `Share “${req.fileName}” with the ${req.domain} domain`,
        detail: `${user.id} requests promoting ${req.fileName} into ${req.target} (visibility: ${req.visibility}). A domain admin must approve.`,
        agent: user.id,
        domain: req.domain,
        requestedBy: user.id,
        tool: 'file_promote',
        payload: req as unknown as Record<string, unknown>,
        approverRole: 'domain_admin',
      });
      return pendingHandle(approval, { artifactKind: kind, target: req.target, domain: req.domain });
    },
  },
  {
    name: 'approve_promotion',
    tab: 'data',
    extraTabs: ['files'],
    minRole: 'domain_admin',
    description:
      'APPLY a filed promotion request (dataset or file) — the Domain-admin/Admin half of the split. Path: the approve step of the Data/Files golden paths. Before: a creator filed `request_promotion`. Governance: domain_admin+ AND in the asset’s domain (both re-checked in-lib); a creator/builder is refused with a typed forbidden. Idempotency: an already-decided request returns a `conflict`.',
    inputSchema: {
      type: 'object',
      properties: { approvalId: { type: 'string', description: 'The approval id from request_promotion.' } },
      required: ['approvalId'],
      examples: [{ approvalId: 'apr_ab12cd34' }],
    },
    call: async (user, args) => {
      const approvalId = str(args.approvalId).trim();
      if (!approvalId) fail('approve_promotion needs an `approvalId`', 400);
      const approval = getApproval(approvalId);
      if (!approval) fail('Promotion request not found', 404);
      if (approval.status !== 'pending') fail(`Already ${approval.status}`, 409);
      if (approval.kind !== 'dataset_promote' && approval.kind !== 'file_promote') {
        fail('approve_promotion only applies dataset/file promotions', 400);
      }
      const p = P(user);
      // Apply BEFORE recording the decision so a blocked gate leaves it pending.
      let applied: unknown;
      if (approval.kind === 'dataset_promote') {
        // T8: the promotion is PHYSICAL — the promote adapter-set runs as the
        // APPROVING Builder (this caller) and the tier flips only on ✓. A failed
        // materialization surfaces the real error and leaves the request pending.
        const out = await publishPromotionLive(approval.payload as unknown as PromotionRequest, p);
        if (!out.ok) fail(`Physical publish failed (tier unchanged): ${out.error}`, 502);
        applied = out.dataset;
      } else {
        applied = applyApprovedFilePromotion(approval.payload as unknown as FilePromotionRequest, p);
      }
      decide(approvalId, 'approve', user.id);
      return { approved: true, kind: approval.kind, approvalId, asset: applied };
    },
  },
];

/** Return the existing pending promotion approval for this asset id, or null. */
function enqueueDedup(kind: 'dataset_promote' | 'file_promote', assetId: string) {
  // Mirror the UI: avoid a duplicate pending request for the same asset.
  return (
    listApprovals({ status: 'pending' }).find((a) => {
      if (a.kind !== kind) return false;
      const pid = kind === 'dataset_promote' ? (a.payload?.datasetId as string) : (a.payload?.fileId as string);
      return pid === assetId;
    }) ?? null
  );
}

// =============================== METRICS ======================================
export const metricWriteTools: McpTool[] = [
  {
    name: 'define_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Define a governed metric on a dataset’s built GOLD version — the one definition of a number (Cube member). The dataset must already be a governed asset/product (promote it in Data first). Returns the canonical member + the generated Cube YAML. THE FULL MEASURE MODEL (same as the Metrics tab form — all optional, a plain call yields exactly {name,type,sql}): `aggregation` — count · count_distinct · count_distinct_approx (fast approximate distinct) · sum · avg · min · max · number (a DERIVED/ratio measure). `filter` — a FILTERED measure: aggregate only rows where {column op value} (op: equals|notEquals|gt|gte|lt|lte|set|notSet). `runningTotal` — a cumulative running total from the beginning of time. `rollingWindow` — a trailing time window (last N day|week|month|quarter|year), mutually exclusive with runningTotal. `ratio` — for aggregation "number", a derived measure numerator/denominator over two OTHER measures on the same cube. `format` — display format (currency|percent|number…). `drillMembers` — drill-down members exposed for exploration. `timeDimension`+`granularity` are query-time (query_metric), not part of the definition.',
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
      return { datasetId, measure, member: measureMember(dataset, measure), cube: scaffoldCubeYaml(dataset) };
    },
  },
];

// ============================== DASHBOARDS ====================================
export const dashboardWriteTools: McpTool[] = [
  {
    name: 'create_dashboard',
    tab: 'dashboards',
    minRole: 'creator',
    description:
      'Create (or replace) a dashboard you own — tiles/charts that reference GOVERNED metric members. Same governed store as the Dashboards tab. Sharing it wider is a separate Builder/Admin governance step.',
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
      const spec = fromTiles(name, view, charts);
      const rec = saveDashboard(P(user), id, spec);
      return { id: rec.id, tier: rec.tier, spec: rec.spec };
    },
  },
];

// =============================== BIG BETS =====================================
export const bigbetWriteTools: McpTool[] = [
  {
    name: 'create_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Frame a Big Bet — an initiative roadmap over real OS components. A creator files a draft; a Builder/Admin owns an active bet (cross-domain bets are Admin-only). Same governed store as the Big Bets tab.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'The problem statement (the bet’s name is derived from it unless `name` given).' },
        owner: { type: 'string', description: 'Who owns the problem (goes into the problem statement’s "who").' },
        solution: { type: 'string', description: 'Optional solution idea.' },
        pillarId: { type: 'string', description: 'Strategy pillar id (default pillar_retention).' },
        metricId: { type: 'string', description: 'North-star metric id (default metric_nrr).' },
        targetValue: { type: 'number', description: 'Value target.' },
        goLive: { type: 'string', description: 'Planned go-live YYYY-MM-DD (default +8 weeks).' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        name: { type: 'string', description: 'Optional explicit display name.' },
      },
      required: ['problem'],
      examples: [{ problem: 'Churn is rising among SMB accounts', owner: 'ben', solution: 'Proactive health-score outreach', pillarId: 'pillar_retention', targetValue: 250000 }],
    },
    call: async (user, args) => {
      const problem = str(args.problem).trim();
      if (!problem) fail('create_big_bet needs a `problem` statement', 400);
      const input: CreateBetInput = {
        name: str(args.name).trim() || deriveBetName(problem),
        problem: { who: str(args.owner), need: problem, obstacle: '', impact: '' },
        solution: str(args.solution) || undefined,
        pillarId: str(args.pillarId) || 'pillar_retention',
        metricId: str(args.metricId) || 'metric_nrr',
        targetValue: num(args.targetValue),
        goLive: str(args.goLive) || defaultGoLive(),
        domain: str(args.domain) || undefined,
      };
      const bet = createBet(P(user), input);
      return { id: bet.id, name: bet.name, status: bet.status };
    },
  },
  {
    name: 'attach_component',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'ATTACH a real OS component — a dataset, a dashboard or an agent system — to a Big Bet you may edit. The bet records a REFERENCE (id · planned-ready date · weight), never a copy; progress is then DERIVED from the component’s real lifecycle. Purpose: the operate half of the Big Bets golden path — a bet over real running artifacts, not a slide. Before: create_big_bet (or list_big_bets), and the component must exist — pick it from list_datasets / list_dashboards / list_agent_systems. After: get_big_bet to read the roadmap + derived status back. Governance: runs AS YOU — the bet edit gate is the store’s own (the owner edits; cross-domain bets are Admin-only), and EVERY component id is re-resolved through its own tab’s canView gate FIRST: an id you cannot see is a typed not_found/forbidden, so a forged id can never attach an unseen component. Idempotency: re-attaching the same artifact adds a second roadmap reference — check get_big_bet first.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet to attach to (from list_big_bets).' },
        kind: { type: 'string', enum: ['dataset', 'dashboard', 'agent-system'], description: 'What kind of component the id names.' },
        id: { type: 'string', description: 'The component id — a dataset id, dashboard id or agent-system id YOU can see.' },
        plannedReady: { type: 'string', description: 'Planned-ready date yyyy-mm-dd (default: +4 weeks).' },
        start: { type: 'string', description: 'Optional start date yyyy-mm-dd (default: today).' },
        weight: { type: 'number', description: 'Optional manual allocation weight 0–100 (when the bet allocates manually).' },
      },
      required: ['betId', 'kind', 'id'],
      examples: [{ betId: 'bet_ab12cd34', kind: 'dashboard', id: 'dash_sales_overview_ab12cd', plannedReady: '2026-09-01' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('attach_component needs a `betId` (from list_big_bets)', 400);
      const id = str(args.id).trim();
      if (!id) fail('attach_component needs the component `id`', 400);
      const kind = str(args.kind);
      if (!['dataset', 'dashboard', 'agent-system'].includes(kind)) {
        fail('attach_component needs `kind` = "dataset" | "dashboard" | "agent-system"', 400);
      }
      const p = P(user);
      // Edit gate FIRST (the store's own rule) — no side effect on a forbidden bet.
      const bet = getBet(betId, p); // view guard (403/404)
      if (!canEditBet(bet, p)) fail('Not permitted to edit this bet', 403);

      // Re-resolve the component through ITS OWN canView gate — a forged/unseen id
      // is a typed not_found/forbidden BEFORE anything is attached.
      let art: LinkedArtifactInput;
      if (kind === 'dataset') {
        const d = getDataset(id, p);
        const anyBuilt = d.versions.bronze.built || d.versions.silver.built || d.versions.gold.built;
        art = {
          id: d.id, tab: 'data', title: d.name, domain: d.domain,
          visibility: d.tier === 'dataset' ? 'personal' : d.tier === 'asset' ? 'shared' : 'marketplace',
          // Data's ready verb is `certified` — a promoted asset/product has passed it.
          lifecycle: d.tier !== 'dataset' ? 'certified' : anyBuilt ? 'building' : 'draft',
        };
      } else if (kind === 'dashboard') {
        const d = getDashboard(id, p);
        art = {
          id: d.id, tab: 'dashboard', title: d.spec.name, domain: d.domain,
          visibility: d.tier === 'personal' ? 'personal' : d.tier === 'domain' ? 'shared' : 'marketplace',
          lifecycle: d.tier === 'personal' ? 'draft' : 'published',
        };
      } else {
        const s = getAgentSystem(id, p);
        art = {
          id: s.id, tab: 'agent', title: s.name, domain: s.domain,
          visibility: s.visibility === 'Personal' ? 'personal' : s.visibility === 'Shared' ? 'shared' : 'marketplace',
          // Agents' ready verb is `live` — reached only by the governed promote.
          lifecycle: s.visibility === 'Personal' ? 'draft' : 'live',
        };
      }
      // Record the REFERENCE CARD in the bet's cross-tab registry (the per-tab
      // store stays the source of truth), then link through the store's own door.
      registerLinkedArtifact(art);
      const plannedReady = str(args.plannedReady).trim() || new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
      const { ref } = addComponent(betId, { ...p, kind: 'human' }, {
        tab: art.tab,
        artifactId: art.id,
        plannedReady,
        start: str(args.start).trim() || undefined,
        weight: typeof args.weight === 'number' ? args.weight : undefined,
      });
      return { betId, refId: ref.id, artifactId: ref.artifactId, tab: ref.tab, title: art.title, plannedReady: ref.plannedReady, origin: ref.origin };
    },
  },
  {
    name: 'update_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'UPDATE a Big Bet you may edit — the solution idea, status (draft | active | shipped | archived), the € target, the go-live date, the value basis, the owner-declared REALIZED value, or the name. Progress itself is DERIVED from the attached components’ real lifecycle and can never be hand-set here — read it back with get_big_bet. Purpose: the iterate half of the Big Bets golden path. Before: create_big_bet / get_big_bet. After: get_big_bet to read the derived state + realized value back. Governance: runs AS YOU through the SAME store gate as the Big Bets tab (the owner edits their bet — a creator their draft; cross-domain bets are Admin-only; no new role floors invented here). An unseen id is a typed not_found/forbidden. Honesty: a `realizedValue` is recorded as the owner-declared value and only counts when the bet’s value basis is `owner-declared` — the response says so when it is not.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet to update (from list_big_bets).' },
        solution: { type: 'string', description: 'The solution idea (how the bet realizes its value).' },
        status: { type: 'string', enum: ['draft', 'active', 'shipped', 'archived'], description: 'Bet lifecycle status.' },
        targetValue: { type: 'number', description: 'The € value target.' },
        realizedValue: { type: 'number', description: 'Owner-declared realized € value (counts under basis owner-declared).' },
        valueBasis: { type: 'string', enum: ['uplift', 'absolute', 'owner-declared'], description: 'How realized value is resolved (default uplift-over-baseline).' },
        goLive: { type: 'string', description: 'Planned go-live yyyy-mm-dd.' },
        name: { type: 'string', description: 'Display name.' },
      },
      required: ['betId'],
      examples: [{ betId: 'bet_ab12cd34', status: 'active', solution: 'Proactive health-score outreach', valueBasis: 'owner-declared', realizedValue: 120000 }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('update_big_bet needs a `betId` (from list_big_bets)', 400);
      const patch: Partial<Pick<BigBet, 'name' | 'solution' | 'targetValue' | 'goLive' | 'valueBasis' | 'ownerDeclaredValue' | 'status'>> = {};
      if (typeof args.solution === 'string') patch.solution = args.solution.trim() || undefined;
      if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
      if (typeof args.targetValue === 'number' && Number.isFinite(args.targetValue)) patch.targetValue = args.targetValue;
      if (typeof args.realizedValue === 'number' && Number.isFinite(args.realizedValue)) patch.ownerDeclaredValue = args.realizedValue;
      if (typeof args.goLive === 'string' && args.goLive.trim()) patch.goLive = args.goLive.trim();
      if (args.status !== undefined) {
        const status = str(args.status);
        if (!['draft', 'active', 'shipped', 'archived'].includes(status)) {
          fail('status must be draft | active | shipped | archived', 400);
        }
        patch.status = status as BigBet['status'];
      }
      if (args.valueBasis !== undefined) {
        const basis = str(args.valueBasis);
        if (!['uplift', 'absolute', 'owner-declared'].includes(basis)) {
          fail('valueBasis must be uplift | absolute | owner-declared', 400);
        }
        patch.valueBasis = basis as ValueBasis;
      }
      if (Object.keys(patch).length === 0) {
        fail('update_big_bet needs at least one field to update (solution, status, targetValue, realizedValue, valueBasis, goLive, name)', 400);
      }
      const bet = updateBet(betId, P(user), patch); // the store's own edit gate (403/404)
      return {
        id: bet.id,
        status: bet.status,
        solution: bet.solution ?? null,
        targetValue: bet.targetValue,
        ownerDeclaredValue: bet.ownerDeclaredValue ?? null,
        valueBasis: bet.valueBasis,
        goLive: bet.goLive,
        updatedAt: bet.updatedAt,
        ...(patch.ownerDeclaredValue !== undefined && bet.valueBasis !== 'owner-declared'
          ? { note: `realizedValue is recorded as the owner-declared value, but this bet resolves value by "${bet.valueBasis}" — set valueBasis: "owner-declared" for it to count.` }
          : {}),
      };
    },
  },
];

// ================================ AGENTS ======================================
export const agentWriteTools: McpTool[] = [
  {
    name: 'create_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Create a new agent system (LangGraph). Always starts Personal/owner-only; sharing is the governed promote ladder (Builder→Shared, Admin→Marketplace). Optionally start from a server-authored template.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'System name, e.g. "Support triage".' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        template: { type: 'string', enum: ['blank', 'analyze', 'evaluate', 'recommend'], description: 'Optional starter template.' },
      },
      required: ['name'],
      examples: [{ name: 'Support triage', domain: 'support', template: 'analyze' }],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_agent_system needs a `name`', 400);
      const rec = createSystem(P(user), {
        name,
        domain: str(args.domain) || undefined,
        template: isTemplateKey(args.template) ? args.template : undefined,
      });
      return { id: rec.id, name: rec.name, visibility: rec.visibility };
    },
  },
  {
    name: 'commit_agent_files',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Commit one or more whitelisted files into an agent system you can edit (only `system.yaml` and `agents/<id>/AGENT.md` | `MEMORY.md`). system.yaml is validated on write. Idempotent per identical content.',
    inputSchema: {
      type: 'object',
      properties: {
        systemId: { type: 'string', description: 'Target system id.' },
        files: {
          type: 'array',
          description: 'Files to write.',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        path: { type: 'string', description: 'Single-file shortcut (use with `content`).' },
        content: { type: 'string', description: 'Single-file content (use with `path`).' },
      },
      required: ['systemId'],
      examples: [
        { systemId: 'sys_ab12cd', files: [{ path: 'agents/analyst/AGENT.md', content: '# Analyst\nYou classify incoming tickets.' }] },
      ],
    },
    call: async (user, args) => {
      const systemId = str(args.systemId).trim();
      if (!systemId) fail('commit_agent_files needs a `systemId`', 400);
      const files = normFiles(args);
      if (!files.length) fail('commit_agent_files needs `files` [{path,content}] (or a single path+content)', 400);
      const p = P(user);
      const committed = files.map((f) => {
        const r = writeAgentFile(systemId, p, { path: f.path, content: f.content, sha: '' });
        return { path: r.path, sha: r.sha };
      });
      return { systemId, committed };
    },
  },
  {
    name: 'build_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Build (execute + verify) an agent system you can edit across the adapters, landing Langfuse traces. Returns ✓/✗ rows. Idempotent — re-run any time.',
    inputSchema: {
      type: 'object',
      properties: { systemId: { type: 'string', description: 'System id to build.' } },
      required: ['systemId'],
      examples: [{ systemId: 'sys_ab12cd' }],
    },
    call: async (user, args) => {
      const systemId = str(args.systemId).trim();
      if (!systemId) fail('build_agent_system needs a `systemId`', 400);
      const view = getSystemForEdit(systemId, P(user));
      return buildSystem(systemId, view.yaml);
    },
  },
  {
    name: 'run_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'RUN an agentic-os team (LangGraph, OS-MCP tool grants) for one turn and return the reply + the per-node governed tool steps — the same in-process, run-as-user executor the Agents tab uses. Purpose: close the Agents golden path (build → RUN) over MCP. Before: list_agent_systems / get_agent_system (and build_agent_system for a ✓ build). After: read the per-node steps; wire the system into a Big Bet or schedule. Governance + recursion, stated honestly: the team’s OWN tool calls dispatch through the SAME governed door as this call (grant-scoped, OPA `os-<systemId>` pre-gated, then handleRpc AS YOU) — so a team can never exceed its declared grants NOR your role; there is no escalation in the loop. You must own the system or be entitled to run it (a domain-Shared system is runnable by in-domain members); a non-runnable id is a typed forbidden. A hermes/legacy-grant system cannot run in-process — that is a typed bad_request pointing to the Agents tab UI. Note: the run drives a live LLM; each node takes seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        systemId: { type: 'string', description: 'The agent system to run (from list_agent_systems).' },
        message: { type: 'string', description: 'The user message for this turn.' },
        messages: {
          type: 'array',
          description: 'Optional multi-turn conversation (overrides `message`); last 20 kept.',
          items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } }, required: ['role', 'content'] },
        },
      },
      required: ['systemId', 'message'],
      examples: [{ systemId: 'sys_ab12cd', message: 'Analyze last quarter’s refund workflow and summarize the risks.' }],
    },
    call: async (user, args) => {
      const systemId = str(args.systemId).trim();
      if (!systemId) fail('run_agent_system needs a `systemId`', 400);
      // Run-scope authorization BEFORE any side effect (owner / in-domain admin /
      // in-domain member of a Shared system) — the same gate as the Agents tab run.
      const view = getSystemForRun(systemId, P(user));
      const msgs = runMessages(args);
      // Dynamic imports: agentic-graph-server reads the tool registry at module init,
      // so a static import here would be a server.ts ↔ write-tools.ts cycle.
      const { isAgenticOsTeam } = await import('@/lib/agents/build/os-tools');
      if (!isAgenticOsTeam(view.system)) {
        fail(
          'This system does not run on the in-process agentic-os path (hermes runtime or legacy/unmapped tool grants) — run it from the Agents tab UI instead',
          400,
        );
      }
      const runTeam = runTeamOverride ?? (await import('@/lib/agents/build/agentic-graph-server')).runOsTeam;
      const team = await runTeam({ user, yaml: view.yaml, systemId, messages: msgs, disabledAgents: view.disabledAgents });
      return {
        systemId,
        mode: 'live',
        path: team.path,
        finalText: team.finalText,
        // Per-node summary: model + governed tool steps (no raw model text — tight).
        nodes: team.runs.map((r) => ({
          node: r.node,
          model: r.model,
          steps: r.result.steps.map((s) => ({ tool: s.tool, isError: s.isError })),
        })),
      };
    },
  },
];

/** One turn's conversation: `messages` (validated, last 20) else the single `message`. */
function runMessages(args: Record<string, unknown>): { role: 'user' | 'assistant'; content: string }[] {
  const raw = Array.isArray(args.messages) ? (args.messages as { role?: string; content?: string }[]) : [];
  const clean = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: (m.content as string).trim() }));
  if (clean.length > 0) return clean;
  const message = str(args.message).trim();
  if (!message) fail('run_agent_system needs a `message` (or `messages`)', 400);
  return [{ role: 'user', content: message }];
}

/** The runOsTeam signature the tool drives (structural, so tests can inject a spy). */
type RunTeamFn = (input: {
  user: CurrentUser;
  yaml: string;
  systemId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  disabledAgents?: string[];
}) => Promise<{
  path: string[];
  finalText: string;
  runs: { node: string; model: string; result: { steps: { tool: string; isError: boolean }[] } }[];
}>;

// runOsTeam drives a LIVE LiteLLM call; tests inject a spy so the wrapper's
// identity threading + governance gates are testable offline (mirrors the
// injectable deps runOsTeam itself exposes). null → the real function.
let runTeamOverride: RunTeamFn | null = null;
export function __setRunOsTeamForTests(fn: RunTeamFn | null): void {
  runTeamOverride = fn;
}

export const ALL_WRITE_TOOLS: McpTool[] = [
  ...dataWriteTools,
  ...knowledgeWriteTools,
  ...fileWriteTools,
  ...metricWriteTools,
  ...dashboardWriteTools,
  ...bigbetWriteTools,
  ...agentWriteTools,
  ...promotionTools,
  // mcp-v2 surfaces wave — Strategy (pillar CRUD) + Marketplace (rate) writes.
  ...strategyWriteTools,
  ...marketplaceWriteTools,
];

// Keep an explicit reference to JsonSchema so the imported type is used (schemas above
// are structurally JsonSchema; this makes the dependency intentional + tree-checked).
export type WriteToolSchema = JsonSchema;
