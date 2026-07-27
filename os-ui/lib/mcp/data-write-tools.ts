/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from './server';
import { roleAtLeast } from '@/lib/core/session';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles, INGEST_MAX_BYTES,
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
  setDatasetSync,
  requireDatasetEditable,
  type PromotionRequest,
} from '@/lib/data/store';
import { DATASET_SYNC_MODES, type DatasetSync, type DatasetSyncMode } from '@/lib/data/dataset-schema';
import { runDatasetSync } from '@/lib/data/sync-run-server';
import { reconcileSyncCron } from '@/lib/data/sync-cron';
import { kajabiCursorField } from '@/lib/connections/kajabi-resources';
import { runQualityChecks } from '@/lib/data/dq-run';
import { proposeFixes, applyFixes, dqComplete, type FixApplyInput } from '@/lib/data/dq-fix-server';
import { DATA_CHECK_RULES, type DataCheckRule } from '@/lib/data';
import { queryRun, executeRun } from '@/lib/infra/governed';
import { publishPromotionLive, rematerializeDomainTableLive } from '@/lib/data/publish-server';
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

// ================================ DATA ========================================
export const dataWriteTools: McpTool[] = [
  {
    name: 'create_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'Create a new PRIVATE dataset (also called: table, data product) — a Bronze→Silver→Gold spine — in one of your domains, the same governed path as the Data tab’s “New dataset”. Starts Personal/owner-only; sharing is the separate governed `promote_dataset`. Optionally seed column docs. Idempotency: each call creates a distinct dataset.',
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
      'Build a dataset’s physical GOLD by JOINING its Silver with other governed datasets you may read — this produces a curated dataset (also called: 360 view, data mart, aggregated dataset, platinum dataset). The Data tab’s stage-4 reuse, compiled into ONE governed CTAS. You pass dataset IDS to join (never table names — each is re-resolved through the canView guard), the join keys, projected dimensions and derived measures (sum/avg/count/count_distinct/min/max, or count(*) with agg "count" and no col). Column refs are {ref, column} where ref 0 = your Silver base and 1..n = the joined datasets in order. KEY MAPPING / RECONCILE: same-name keys auto-match with no extra config; when the two sides differ, set the join key’s optional `adapt` to reconcile them symmetrically (both sides wrapped): `{mode:"text"}` normalizes to lower(trim(cast … as varchar)) so keys differing only by case/whitespace/format line up, `{mode:"cast",type}` coerces both sides to one Trino type (varchar|integer|bigint|double|boolean|date|timestamp) — e.g. an id stored as varchar on one side, integer on the other. Purpose: the reuse step of the physical Data golden path — the measures recorded here feed define_metric after promotion. Before: transform_silver (Silver must be built); pick join partners from list_datasets (governed asset/product tiers with a built table). After: document_dataset → request_promotion → define_metric. Governance: the CTAS targets YOUR OWN schema and executes AS YOU (Trino→OPA masks every joined read); a non-visible pick is a typed forbidden; Gold + lineage + measures are recorded ONLY on a ✓ apply+verify.',
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
        rematerializeOnly: {
          type: 'boolean',
          description:
            'REPAIR MODE: true skips the build and just re-runs the publish CTAS (owner’s personal gold → domain schema) for an ALREADY-PROMOTED dataset whose domain table is missing or stale. Builder+ only; picks are ignored (pass []). Never touches versions/lineage/measures.',
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

      // REPAIR MODE (parity with the gold-join route): re-run ONLY the publish CTAS for a
      // promoted dataset whose domain table is missing/stale — no build, no spec needed.
      if (args.rematerializeOnly === true) {
        if (dataset.tier === 'dataset') fail('Not promoted — nothing to re-materialize', 400);
        if (!roleAtLeast(user.role, 'builder')) {
          fail('Re-materializing the shared domain table needs Builder or above', 403);
        }
        const out = await rematerializeDomainTableLive(datasetId, p);
        return {
          ok: out.ok,
          domainTable: out.ok
            ? { state: 'refreshed', fqn: out.fqn }
            : { state: 'stale', fqn: out.fqn, reason: out.error },
        };
      }

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
      // Northpeak fix — MATERIALIZATION DRIFT (MCP parity with the gold-join route): a
      // rebuild of an ALREADY-PROMOTED dataset leaves the governed domain table (what Cube
      // reads) on the prior snapshot. Auto-refresh it as a Builder+ (the write floor);
      // otherwise report an honest STALE state. Best-effort — never fails the ✓ rebuild.
      let domainTable: { state: 'refreshed' | 'stale' | 'not-promoted'; fqn?: string; reason?: string } =
        { state: 'not-promoted' };
      if (updated.tier !== 'dataset') {
        if (roleAtLeast(user.role, 'builder')) {
          try {
            const out = await rematerializeDomainTableLive(datasetId, p);
            domainTable = out.ok
              ? { state: 'refreshed', fqn: out.fqn }
              : { state: 'stale', fqn: out.fqn, reason: out.error };
          } catch (e) {
            domainTable = { state: 'stale', reason: e instanceof Error ? e.message : String(e) };
          }
        } else {
          domainTable = { state: 'stale', reason: 'Rebuilt by a creator — a Builder must re-promote to refresh the shared domain table.' };
        }
      }
      return {
        ok: true,
        mode: build.mode,
        sql: plan.sql,
        target: plan.target,
        goldRegistered: true,
        measures: updated.measures,
        upstreams: updated.upstreams,
        domainTable,
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
      'Run a dataset’s data-quality rules and READ the result — the "Run checks" button. Each structured rule is compiled to a governed COUNT-of-violations SQL and executed through the SAME governed query path AS THE OWNER (a private dataset’s personal_<uid> table is read as its owner, OPA-governed), producing a REAL pass/fail per rule plus an aggregate badge (passing | failing | unknown). Honesty: a rule that can’t run (nothing materialised yet, or a free-text intention) is reported "not_run", NEVER a fake pass. Before: define_quality_rules (+ a built layer to check). After: propose_quality_fixes on a failing rule to get AI-proposed remediations. Governance: Creator+ on a dataset you can see; read-only.',
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
  {
    name: 'propose_quality_fixes',
    tab: 'data',
    minRole: 'creator',
    description:
      'PROPOSE AI remediations for ONE failing quality rule — the Validate stage’s "Propose fixes" button, the SAME governed path as POST /api/data/datasets/:id/dq/propose. The rule is re-run FOR REAL first (a passing rule proposes nothing); failing rows are sampled (honest "showing N of M"); the REASONING model establishes the fix and the STANDARD model fills per-row values (the model split). Returns EITHER a batch proposal (ONE guard-validated column-transform expression, previewed before→after with a MEASURED residual — estimatedFix is derived by SQL, never trusted from the model), OR per-row fixes (ONLY when the dataset declares a unique key column and ≤200 rows fail — row identity is NEVER guessed), OR an honest kind:"none" diagnosis for rules a single-column edit cannot fix (e.g. unique). Model unconfigured/over-cap/unreachable ⇒ offline:true, never a fake proposal. READ-ONLY: nothing is applied — apply_quality_fixes is the explicit, edit-gated write door. Before: run_quality_checks (to find the failing rule id). Governance: Creator+ on a dataset you can see.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id (from list_datasets).' },
        checkId: { type: 'string', description: 'The failing rule’s check id (from run_quality_checks results).' },
      },
      required: ['datasetId', 'checkId'],
      examples: [{ datasetId: 'ds_ab12cd', checkId: 'chk_1' }],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      const checkId = str(args.checkId).trim();
      if (!datasetId) fail('propose_quality_fixes needs a `datasetId`', 400);
      if (!checkId) fail('propose_quality_fixes needs a `checkId`', 400);
      const p = P(user);
      const dataset = getDataset(datasetId, p); // canView gate
      const check = (dataset.checks ?? []).find((c) => c.id === checkId);
      if (!check) fail('unknown check — run run_quality_checks to list the rule ids', 404);
      const resolved = builtLayerFqn(dataset, p);
      return proposeFixes(dataset, check, {
        fqn: resolved?.fqn ?? null,
        layer: resolved?.layer ?? null,
        queryFn: (sql) => queryRun(sql, resolved?.principal),
        complete: dqComplete({ id: user.id, domains: user.domains }),
      });
    },
  },
  {
    name: 'apply_quality_fixes',
    tab: 'data',
    minRole: 'creator',
    description:
      'APPLY accepted DQ remediations for ONE rule — the Validate stage’s "Apply" buttons, the SAME governed path as POST /api/data/datasets/:id/dq/apply. Modes: batch (ONE column-transform expression, re-validated server-side by the fix guard — statements/subqueries/unknown identifiers are refused) or rows ({pk,proposed} pairs bound as escaped literals, matched on the dataset’s DECLARED unique key — refused honestly when no key is declared). Executes ONE whitelisted MERGE through the governed /execute AS YOU (the query-tool re-gates statement shape + schema/role floor), then RE-RUNS the rule — the response’s `recheck` is the real post-fix verdict (a fix that didn’t fix stays red). Records a durable remediation run (batch id + pre-apply Iceberg snapshot id; revert is via Console — no governed rollback shape exists). NOTHING applies except through this explicit call. Before: propose_quality_fixes (or your own expression). Governance: edit scope (owner / in-domain domain_admin+), re-checked in-lib; role floor for the physical write re-enforced by the query-tool.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id (from list_datasets).' },
        checkId: { type: 'string', description: 'The rule’s check id (from run_quality_checks).' },
        mode: { type: 'string', enum: ['batch', 'rows'], description: 'batch = one column-transform expression; rows = explicit per-row values.' },
        sqlExpr: { type: 'string', description: 'batch only: the column-transform expression (guard-validated).' },
        fixes: {
          type: 'array',
          description: 'rows only: the accepted fixes.',
          items: {
            type: 'object',
            properties: {
              pk: { type: 'string', description: 'Key-column value of the row to fix.' },
              proposed: { type: 'string', description: 'The corrected value (bound as a literal).' },
            },
            required: ['pk', 'proposed'],
          },
        },
      },
      required: ['datasetId', 'checkId', 'mode'],
      examples: [
        { datasetId: 'ds_ab12cd', checkId: 'chk_1', mode: 'batch', sqlExpr: 'trim(lower(email))' },
        { datasetId: 'ds_ab12cd', checkId: 'chk_2', mode: 'rows', fixes: [{ pk: 'ord_0012', proposed: 'EU' }] },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      const checkId = str(args.checkId).trim();
      if (!datasetId) fail('apply_quality_fixes needs a `datasetId`', 400);
      if (!checkId) fail('apply_quality_fixes needs a `checkId`', 400);
      const p = P(user);
      const dataset = requireDatasetEditable(datasetId, p); // edit gate (403/404)
      const check = (dataset.checks ?? []).find((c) => c.id === checkId);
      if (!check) fail('unknown check — run run_quality_checks to list the rule ids', 404);
      const resolved = builtLayerFqn(dataset, p);
      if (!resolved) fail('nothing is built yet — there is no table to fix', 409);

      let input: FixApplyInput;
      const mode = str(args.mode).trim();
      if (mode === 'batch') {
        const sqlExpr = str(args.sqlExpr).trim();
        if (!sqlExpr) fail('batch mode needs a `sqlExpr`', 400);
        input = { mode: 'batch', sqlExpr };
      } else if (mode === 'rows') {
        const fixes = (Array.isArray(args.fixes) ? args.fixes : [])
          .map((f) => {
            const r = f as Record<string, unknown>;
            return { pk: str(r?.pk).trim(), proposed: typeof r?.proposed === 'string' ? r.proposed : String(r?.proposed ?? '') };
          })
          .filter((f) => f.pk.length > 0);
        if (fixes.length === 0) fail('rows mode needs at least one accepted fix', 400);
        input = { mode: 'rows', fixes };
      } else {
        fail("apply_quality_fixes `mode` must be 'batch' or 'rows'", 400);
      }

      return applyFixes(dataset, check, input, {
        fqn: resolved.fqn,
        layer: resolved.layer,
        queryFn: (sql) => queryRun(sql, resolved.principal),
        // The governed WRITE runs AS the caller — identity from the session, never args.
        executeFn: (sql) =>
          executeRun(sql, { principal: resolved.principal, uid: user.id, domains: user.domains, role: user.role }),
        ranBy: user.id,
        domain: dataset.domain,
      });
    },
  },
  {
    name: 'retire_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'RETIRE a dataset you can edit — the Data tab’s lifecycle, the counterpart to `retire_knowledge`: `archive` (the default: reversible soft-hide, retains the record + medallion versions + history; it just stops showing in the default list) or `delete` (PHYSICAL, irreversible removal of the registry record). Same governed store the Data tab + `/api/data/datasets/[id]` call. LINEAGE-AWARE on delete: blocked with a typed 409 if any domain still imports the data product (mirrors deleteDataset — remove subscribers first). Role gate (edit scope, re-checked in-lib): the OWNER may retire their own Personal/unshared dataset; a SHARED/domain dataset needs a same-domain Builder+ (or Admin). Idempotency: retiring a missing dataset is a typed not_found (no existence leak). Use to clean up stray/duplicate datasets (e.g. leftovers from a runaway agent loop).',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'The dataset id to retire (from list_datasets).' },
        action: {
          type: 'string',
          enum: ['archive', 'delete'],
          description: 'archive = reversible soft-hide (default); delete = physical, irreversible removal.',
        },
      },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd' }, { datasetId: 'ds_ab12cd', action: 'delete' }],
    },
    call: async (user, args) => {
      const id = str(args.datasetId).trim();
      if (!id) fail('retire_dataset needs a `datasetId`', 400);
      const action = str(args.action).trim() || 'archive';
      if (action !== 'archive' && action !== 'delete') {
        fail("retire_dataset `action` must be 'archive' or 'delete'", 400);
      }
      const p = P(user);
      // View-scope + existence guard first (typed 403/404) so a role/lineage message
      // never leaks a dataset the caller can't even see.
      const d = getDataset(id, p);
      if (action === 'archive') {
        const rec = archiveDataset(id, p); // edit-gated in-lib (owner or same-domain Builder+)
        return { id, name: rec.name, action: 'archive', archived: true, reversible: true };
      }
      // PHYSICAL delete: edit-gated + lineage-aware (409 if imported) in-lib.
      deleteDataset(id, p);
      return { id, name: d.name, action: 'delete', deleted: true, reversible: false };
    },
  },
  {
    name: 'set_dataset_sync',
    tab: 'data',
    minRole: 'creator',
    description:
      'Configure (or enable/disable) SCHEDULED INCREMENTAL SYNC (also called: refresh, data pipeline, ETL) on a connector-backed dataset you can edit — the Data tab’s "Keep this in sync" panel, the SAME governed path as PUT /api/data/datasets/:id/sync: the strict store gate validates, then the per-dataset CronJob is reconciled and the cluster outcome is reported HONESTLY (`cron.live:false` when no CronJob could be provisioned — never a claim). Modes: full-refresh (re-copy each run) · append (rows newer than the cursor; late rows may re-deliver) · merge (upsert by mergeKeys — warehouse sources only, daily-ish cadence). PER-SOURCE LOCKS (the panel’s rules, enforced server-side): kafka → append ONLY, cursor auto-locked to partition offsets; salesforce → no merge, incremental cursor auto-locked to SystemModstamp; kajabi → no merge, cursor auto-locked to the resource’s DOCUMENTED field — `purchases` is true incremental (updated_at: new AND changed), contacts/customers/orders/form_submissions are created_at-only (NEW records append; EDITS are not detected — full-refresh to capture them), cursorless resources (offers, products, transactions, …) are full-refresh ONLY (a typed bad_request otherwise, never fake incremental). Warehouse sources pass their own `cursor` {column, kind}. Schedule: a preset (every-15-minutes|every-30-minutes|hourly|daily|weekly) or a 5-field cron. Before: create_dataset + a first import/ingest from the connection. After: sync_dataset_now to run immediately, get_sync_status to watch. Governance: edit scope (owner / domain admin) re-checked in-lib; the sync executes AS the dataset OWNER, never a service principal.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Target dataset id (from list_datasets).' },
        connectionId: { type: 'string', description: 'The source connection id (from list_connections) — warehouse/Kafka, Salesforce or Kajabi.' },
        source: {
          type: 'object',
          description: 'What to pull: {schema, table}. For API sources, table is the object/resource (e.g. Salesforce "Account", Kajabi "purchases") and schema is a label (e.g. "salesforce").',
          properties: { schema: { type: 'string' }, table: { type: 'string' } },
          required: ['schema', 'table'],
        },
        mode: { type: 'string', enum: [...DATASET_SYNC_MODES], description: 'full-refresh | append | merge (see the per-source locks in the tool description).' },
        cursor: {
          type: 'object',
          description: 'Warehouse sources only — the new-rows column: {column, kind: timestamp|number}. Kafka/Salesforce/Kajabi lock the cursor automatically; anything passed here is ignored for them.',
          properties: { column: { type: 'string' }, kind: { type: 'string', enum: ['timestamp', 'number'] } },
          required: ['column'],
        },
        mergeKeys: { type: 'array', items: { type: 'string' }, description: 'merge mode only: the upsert key column(s).' },
        schedule: { type: 'string', description: 'A preset — every-15-minutes (*/15 * * * *) | every-30-minutes (*/30 * * * *) | hourly (0 * * * *) | daily (0 6 * * *) | weekly (0 6 * * 1) — or a raw 5-field cron (UTC).' },
        enabled: { type: 'boolean', description: 'false keeps the config but deletes the schedule trigger (default true).' },
      },
      required: ['datasetId', 'connectionId', 'source', 'mode', 'schedule'],
      examples: [
        { datasetId: 'ds_ab12cd', connectionId: 'conn_x1', source: { schema: 'sales', table: 'orders' }, mode: 'append', cursor: { column: 'updated_at', kind: 'timestamp' }, schedule: 'hourly' },
        { datasetId: 'ds_ab12cd', connectionId: 'conn_kj1', source: { schema: 'kajabi', table: 'purchases' }, mode: 'append', schedule: 'daily' },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('set_dataset_sync needs a `datasetId`', 400);
      const connectionId = str(args.connectionId).trim();
      if (!connectionId) fail('set_dataset_sync needs a `connectionId` (from list_connections)', 400);
      const src = (args.source ?? {}) as Record<string, unknown>;
      const schema = str(src.schema).trim();
      const table = str(src.table).trim();
      if (!schema || !table) fail('set_dataset_sync needs `source` {schema, table}', 400);
      const mode = str(args.mode) as DatasetSyncMode;
      if (!DATASET_SYNC_MODES.includes(mode)) fail(`sync \`mode\` must be ${DATASET_SYNC_MODES.join('|')}`, 400);
      const scheduleIn = str(args.schedule).trim();
      if (!scheduleIn) fail('set_dataset_sync needs a `schedule` (preset or 5-field cron)', 400);
      const cron = SYNC_SCHEDULE_PRESETS[scheduleIn.toLowerCase()] ?? scheduleIn;

      const p = P(user);
      getDataset(datasetId, p); // view-scope + existence guard first (typed 403/404 — no leak)

      // PER-SOURCE MODE/CURSOR LOCKS — the SAME truth the SyncPanel renders and the
      // executor re-enforces (kafka: store gate; salesforce/kajabi: slice runners;
      // kajabi cursor honesty: kajabi-resources.ts). Enforced here at CONFIG time so
      // an agent can never save a schedule that would only fail at run time.
      const platform = await syncSourcePlatform(connectionId, user);
      let cursor: DatasetSync['cursor'];
      if (platform === 'kafka') {
        if (mode !== 'append') {
          fail('Kafka topics sync append-only (streams have no stable key to merge on; replacing the copy is the reset action, not a mode) — use mode "append"', 400);
        }
        cursor = { kind: 'kafka-offsets', column: '_partition_offset' }; // tracked automatically
      } else if (platform === 'salesforce') {
        if (mode === 'merge') fail('Salesforce sync supports append or full-refresh only (merge needs a federated SQL source)', 400);
        if (mode === 'append') cursor = { kind: 'timestamp', column: 'SystemModstamp' }; // locked — set automatically
      } else if (platform === 'kajabi') {
        if (mode === 'merge') fail('Kajabi sync supports append or full-refresh only (merge needs a federated SQL source)', 400);
        if (mode === 'append') {
          const field = kajabiCursorField(table);
          if (!field) {
            fail(`Kajabi resource '${table}' documents no timestamp cursor — full-refresh is the only honest sync mode for it (use mode "full-refresh")`, 400);
          }
          cursor = { kind: 'timestamp', column: field }; // locked to the documented field
        }
      } else if (mode !== 'full-refresh') {
        const cur = (args.cursor ?? {}) as Record<string, unknown>;
        const column = str(cur.column).trim();
        if (!column) fail(`sync mode '${mode}' needs a \`cursor\` {column, kind: timestamp|number} for this source`, 400);
        cursor = { kind: str(cur.kind) === 'number' ? 'number' : 'timestamp', column };
      }

      const sync: DatasetSync = {
        connectionId,
        source: { schema, table },
        mode,
        ...(cursor ? { cursor } : {}),
        ...(mode === 'merge' ? { mergeKeys: strArr(args.mergeKeys) } : {}),
        schedule: { cron },
        enabled: args.enabled === undefined ? true : bool(args.enabled),
      };
      // The store's STRICT gate — edit scope, valid cron, cursor-for-incremental,
      // merge keys — the SAME authority the PUT route delegates to (no re-derived
      // validation here). Then reconcile the per-dataset CronJob and report the
      // cluster outcome honestly (live:false is a saved-but-not-provisioned truth).
      const dataset = setDatasetSync(datasetId, p, sync);
      const cronOut = await reconcileSyncCron(datasetId, dataset.sync ?? null);
      return { datasetId, platform, sync: dataset.sync ?? null, cron: cronOut };
    },
  },
  {
    name: 'sync_dataset_now',
    tab: 'data',
    minRole: 'creator',
    description:
      'Trigger ONE immediate sync run (also called: refresh, data pipeline, ETL) of a dataset you can edit — the panel’s "Sync now" (or, with reset:true, "Reset & full re-sync": replace the copy and restart the cursor from now), the SAME governed executor as POST /api/data/datasets/:id/sync. Returns the outcome HONESTLY: {run} with the real run record (status ok|error, rowsAffected, cursor window, batchId) after the write confirmed — the cursor advances ONLY on success; or {skipped, reason} when another run holds the lease or nothing is due (skip-not-queue, never a phantom success); a dataset with no sync configured is a typed conflict. A successful manual run also clears quarantine. Before: set_dataset_sync. After: get_sync_status for history + watermark. Governance: edit scope re-checked (same gate as the route’s manual trigger); the sync itself executes AS the dataset OWNER through the governed query path — never a service principal.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id with a configured sync (from set_dataset_sync / list_datasets).' },
        reset: { type: 'boolean', description: 'true = full re-sync: replace the copy and restart the cursor from now.' },
      },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd' }, { datasetId: 'ds_ab12cd', reset: true }],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('sync_dataset_now needs a `datasetId`', 400);
      const p = P(user);
      getDataset(datasetId, p); // view-scope guard first (typed 403/404 — no leak)
      requireDatasetEditable(datasetId, p); // the SAME edit gate as the route's manual POST
      const outcome = await runDatasetSync(datasetId, bool(args.reset) ? 'reset' : 'manual');
      if (!outcome.ok) fail(outcome.error, outcome.status);
      if (outcome.skipped) return { skipped: true, reason: outcome.reason, run: outcome.run ?? null };
      return { skipped: false, run: outcome.run };
    },
  },
];

/** The panel's schedule presets, verbatim (SyncPanel.tsx PRESETS) — plus raw cron. */
const SYNC_SCHEDULE_PRESETS: Record<string, string> = {
  'every-15-minutes': '*/15 * * * *',
  'every-30-minutes': '*/30 * * * *',
  hourly: '0 * * * *',
  daily: '0 6 * * *',
  weekly: '0 6 * * 1',
};

/** The source connection's sync platform — the SAME mapping the sync status route
 *  uses (warehouse ⇒ its platform e.g. kafka/snowflake; salesforce-api ⇒ salesforce;
 *  kajabi-api ⇒ kajabi; anything else ⇒ null). Resolved through the governed
 *  connection store AS the caller — an unseeable connection is a typed 403/404.
 *  Lazy import (the route's pattern): the heavy connections store stays out of the
 *  static graph. */
async function syncSourcePlatform(connectionId: string, user: CurrentUser): Promise<string | null> {
  const { getConnectionForUser } = await import('@/lib/connections/store');
  const c = await getConnectionForUser(connectionId, user);
  return c.template === 'warehouse' && c.warehouse
    ? c.warehouse.platform
    : c.template === 'salesforce-api'
      ? 'salesforce'
      : c.template === 'kajabi-api'
        ? 'kajabi'
        : null;
}

/** The governed WRITE identity, derived from the SESSION user (never the args). */
function executeIdentity(u: CurrentUser): ExecuteIdentity {
  return { principal: u.domains[0] ?? u.id, uid: u.id, domains: u.domains, role: u.role };
}

