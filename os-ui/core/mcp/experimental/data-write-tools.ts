/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool, JsonSchema } from '@core/mcp/server';
import { roleAtLeast } from '@core/kernel/session';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles, INGEST_MAX_BYTES,
  type Principal,
} from '@core/mcp/write-common';

// --- Governed lib functions (the EXACT same the UI + /api routes call) ---------
import {
  setDocs as setDatasetDocs,
  requestPromotion as requestDatasetPromotion,
  getDataset,
  archiveDataset,
  deleteDataset,
  defineMeasure,
  builtLayerFqn,
  requireDatasetEditable,
  type PromotionRequest,
} from '@tabs/data/lib/store';
import { DATASET_SYNC_MODES, type DatasetSyncMode } from '@tabs/data/lib/dataset-schema';
// The governed data MUTATIONS — one service function per operation, shared BYTE FOR BYTE with the
// Data tab's routes (engine rebuild B4, checklist X8: same commit, same Dagster launch, same error).
import {
  createDatasetService,
  commitVersionService,
  transformSilverService,
  buildGoldJoinService,
  rematerializeDomainTableService,
  defineQualityRulesService,
  runQualityChecksService,
  saveDatasetSyncService,
  syncDatasetNowService,
  type QualityRuleInput,
} from '@tabs/data/lib/mutations-server';
import { proposeFixes, applyFixes, dqComplete, type FixApplyInput } from '@tabs/data/lib/dq-fix-server';
import { DATA_CHECK_RULES } from '@tabs/data/lib/index';
import { queryRun, executeRun } from '@core/infra/governed';
import { publishPromotionLive } from '@tabs/data/lib/publish-server';
import { reconcileDomainTablesLive } from '@tabs/data/lib/reconcile-server';
import { enqueue, getApproval, decide, listApprovals } from '@core/policy/approvals';
import { ingestAndRegisterBronze } from '@tabs/data/lib/ingest';
import { CAST_TYPES } from '@tabs/data/lib/transform';
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
import { fromTiles, type ChartSpec } from '@tabs/dashboards/lib/model';
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

// ================================ DATA ========================================
const tools: McpTool[] = [
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
    call: async (user, args) =>
      // The SAME service the Data tab's "New dataset" route calls (checklist X8).
      createDatasetService(P(user), { name: args.name, domain: args.domain, columns: colDocs(args.columns) }),
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
      // The ONE honest commit path, shared with the version route (checklist X8): silver/gold
      // are registered ONLY after the materialize-or-probe build report is ✓.
      const outcome = await commitVersionService(P(user), datasetId, {
        layer: args.layer,
        quality: args.quality,
        passThrough: args.passThrough,
        body: args.body,
      });
      if (!outcome.ok || !outcome.dataset) {
        fail(`${str(args.layer)} commit did not pass${outcome.build ? ` (${outcome.build.mode})` : ''}: ${outcome.error ?? 'apply/verify failed'} — nothing was registered`, 502);
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
      // The SAME service the Transform panel's route calls (checklist X8): server-side compile,
      // governed CTAS as the caller, registration only on a ✓, then the Dagster launch.
      const out = await transformSilverService(P(user), datasetId, { columns: strArr(args.columns), ops: args.ops });
      if (!out.ok || !out.dataset) {
        fail(`Silver build did not pass (${out.build.mode}): ${out.error ?? 'apply/verify failed'} — nothing was registered`, 502);
      }
      const d = out.dataset;
      return {
        ok: true,
        mode: out.build.mode,
        sql: out.sql,
        target: out.target,
        silverRegistered: true,
        dagsterLaunch: out.launched ? 'launching' : 'off',
        domainTable: out.domainTable,
        dots: { bronze: d.versions.bronze.built, silver: d.versions.silver.built, gold: d.versions.gold.built },
      };
    },
  },
  {
    name: 'build_gold_join',
    tab: 'data',
    minRole: 'creator',
    description:
      'Build a dataset’s physical GOLD by JOINING its Silver with other governed datasets you may read — this produces a curated dataset (also called: 360 view, data mart, aggregated dataset, platinum dataset). The Data tab’s stage-4 reuse, compiled into ONE governed CTAS. You pass dataset IDS to join (never table names — each is re-resolved through the canView guard), the join keys, projected dimensions and derived measures (sum/avg/count/count_distinct/min/max, or count(*) with agg "count" and no col). Column refs are {ref, column} where ref 0 = your Silver base and 1..n = the joined datasets in order. KEY MAPPING / RECONCILE: same-name keys auto-match with no extra config; when the two sides differ, set the join key’s optional `adapt` to reconcile them symmetrically (both sides wrapped): `{mode:"text"}` normalizes to lower(trim(cast … as varchar)) so keys differing only by case/whitespace/format line up, `{mode:"cast",type}` coerces both sides to one Trino type (varchar|integer|bigint|double|boolean|date|timestamp) — e.g. an id stored as varchar on one side, integer on the other. Purpose: the reuse step of the physical Data golden path — the measures recorded here feed define_metric after promotion. Before: transform_silver (Silver must be built); pick join partners from list_datasets — a join partner is either (a) a governed asset/product dataset you can read, OR (b) one of your OWN personal (My-tier) datasets built to Silver/Gold (compose a curated dataset from your own private data — its personal lane is read AS you). Each pick is still re-resolved through the canView guard and the CTAS runs AS you. After: document_dataset → request_promotion → define_metric. Governance: the CTAS targets YOUR OWN schema and executes AS YOU (Trino→OPA masks every joined read); a non-visible pick is a typed forbidden; Gold + lineage + measures are recorded ONLY on a ✓ apply+verify.',
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
              datasetId: { type: 'string', description: 'A dataset id you can READ — a governed asset/product, or your OWN personal (My-tier) dataset built to Silver/Gold.' },
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

      // REPAIR MODE (parity with the gold-join route): re-run ONLY the publish CTAS for a
      // promoted dataset whose domain table is missing/stale — no build, no spec needed.
      if (args.rematerializeOnly === true) {
        const out = await rematerializeDomainTableService(p, datasetId);
        return { ok: out.ok, domainTable: out.domainTable };
      }

      // The SAME service the Composition panel's route calls (checklist X8): every pick
      // re-resolved through the canView guard to its owner-aware table, ONE compiled CTAS as
      // the caller, version + measures + lineage only on a ✓, then the Dagster launch and the
      // governed domain copy's refresh.
      const out = await buildGoldJoinService(p, datasetId, {
        baseDatasetId: args.baseDatasetId,
        picks: args.picks,
        dimensions: args.dimensions,
        measures: args.measures,
        derived: args.derived,
        goldSpec: args.goldSpec,
      });
      if (!out.ok || !out.dataset) {
        fail(`Gold join did not pass (${out.build.mode}): ${out.error ?? 'apply/verify failed'} — nothing was recorded`, 502);
      }
      return {
        ok: true,
        mode: out.build.mode,
        sql: out.sql,
        target: out.target,
        goldRegistered: true,
        dagsterLaunch: out.launched ? 'launching' : 'off',
        measures: out.dataset.measures,
        upstreams: out.dataset.upstreams,
        domainTable: out.domainTable,
      };
    },
  },
  {
    name: 'define_quality_rules',
    tab: 'data',
    minRole: 'creator',
    description:
      'Add one or more data-quality RULES to a dataset you can edit — the Data tab’s "Data quality" editor. Each rule is executable: not_null(column), not_blank(column), unique(column), accepted_values(column, values[]), range(column, min?, max?), reference(column, toDataset, toColumn). Rules are stored on the dataset.yaml spine (versioned + discoverable) and become dbt tests in your domain’s project, so the SCHEDULED build enforces them. `reference` is referential integrity — every value of `column` must exist in `toDataset`.`toColumn` — emitted as dbt’s `relationships` test; it is the one rule the ad-hoc `run_quality_checks` probe reports as `not_run` (it needs the target table, which the probe does not resolve), so read its verdict from the build’s asset checks. `toDataset` must be a dataset you can see, must not be the dataset itself, and `toColumn` must be a plain identifier. Before: get_dataset (to see the real column names, and the referenced dataset’s). After: run_quality_checks to get a real pass/fail for the other rules. Governance: Creator+ on a dataset you own (or domain Admin); each rule needs a column. Idempotent-ish: re-running appends rules.',
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
              toDataset: { type: 'string', description: 'reference: the dataset id whose `toColumn` every value must exist in (from list_datasets).' },
              toColumn: { type: 'string', description: 'reference: the referenced column in `toDataset` (a plain identifier).' },
              min: { type: 'number', description: 'range: inclusive lower bound (optional).' },
              max: { type: 'number', description: 'range: inclusive upper bound (optional).' },
            },
            required: ['rule', 'column'],
          },
        },
      },
      required: ['datasetId', 'rules'],
      examples: [
        { datasetId: 'ds_ab12cd', rules: [{ rule: 'not_null', column: 'order_id' }, { rule: 'range', column: 'net_amount', min: 0 }, { rule: 'accepted_values', column: 'status', values: ['open', 'shipped', 'closed'] }, { rule: 'reference', column: 'customer_id', toDataset: 'ds_cust01', toColumn: 'customer_id' }] },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('define_quality_rules needs a `datasetId`', 400);
      const rulesIn = Array.isArray(args.rules) ? (args.rules as QualityRuleInput[]) : [];
      if (rulesIn.length === 0) fail('define_quality_rules needs at least one rule', 400);
      // The SAME service the DQ editor's route calls with one rule (checklist X8).
      const dataset = defineQualityRulesService(P(user), datasetId, rulesIn);
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
      // The SAME service the "Run checks" route calls (checklist X8): the dataset's rules AND
      // its heuristic monitors, run AS the owner and persisted as one run of the durable series.
      return runQualityChecksService(P(user), datasetId);
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
      'Configure (or enable/disable) SCHEDULED INCREMENTAL SYNC (also called: refresh, data pipeline, ETL) on a connector-backed dataset you can edit — the Data tab’s "Keep this in sync" panel, the SAME governed path as PUT /api/data/datasets/:id/sync (one service, `saveDatasetSyncService`): the per-source locks below are applied, the strict store gate validates, and the SCHEDULE is then owned by Dagster — it is committed into your domain’s repository as an `os/schedules.yml` entry and run by the `sovereign` code location, so NO Kubernetes CronJob is provisioned and a pre-B2 one is removed. The `cron` field reports that honestly (`live:false` when the cluster could not be reached — never a claim). Modes: full-refresh (re-copy each run) · append (rows newer than the cursor; late rows may re-deliver) · merge (upsert by mergeKeys — warehouse sources only, daily-ish cadence). PER-SOURCE LOCKS (the panel’s rules, enforced server-side): kafka → append ONLY, cursor auto-locked to partition offsets; salesforce → no merge, incremental cursor auto-locked to SystemModstamp; kajabi → no merge, cursor auto-locked to the resource’s DOCUMENTED field — `purchases` is true incremental (updated_at: new AND changed), contacts/customers/orders/form_submissions are created_at-only (NEW records append; EDITS are not detected — full-refresh to capture them), cursorless resources (offers, products, transactions, …) are full-refresh ONLY (a typed bad_request otherwise, never fake incremental). Warehouse sources pass their own `cursor` {column, kind}. Schedule: a preset (every-15-minutes|every-30-minutes|hourly|daily|weekly) or a 5-field cron. Before: create_dataset + a first import/ingest from the connection. After: sync_dataset_now to run immediately, get_sync_status to watch. Pass `clear: true` (and nothing else) to REMOVE the sync entirely, exactly as the panel’s "Remove sync" does. Governance: edit scope (owner / domain admin) re-checked in-lib; the sync executes AS the dataset OWNER, never a service principal.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Target dataset id (from list_datasets).' },
        connectionId: { type: 'string', description: 'The source connection id (from list_connections) — warehouse/Kafka, Salesforce or Kajabi. Required unless `clear: true`.' },
        source: {
          type: 'object',
          description: 'What to pull: {schema, table}. For API sources, table is the object/resource (e.g. Salesforce "Account", Kajabi "purchases") and schema is a label (e.g. "salesforce"). Required unless `clear: true`.',
          properties: { schema: { type: 'string' }, table: { type: 'string' } },
          required: ['schema', 'table'],
        },
        mode: { type: 'string', enum: [...DATASET_SYNC_MODES], description: 'full-refresh | append | merge (see the per-source locks in the tool description). Required unless `clear: true`.' },
        cursor: {
          type: 'object',
          description: 'Warehouse sources only — the new-rows column: {column, kind: timestamp|number}. Kafka/Salesforce/Kajabi lock the cursor automatically; anything passed here is ignored for them.',
          properties: { column: { type: 'string' }, kind: { type: 'string', enum: ['timestamp', 'number'] } },
          required: ['column'],
        },
        mergeKeys: { type: 'array', items: { type: 'string' }, description: 'merge mode only: the upsert key column(s).' },
        schedule: { type: 'string', description: 'A preset — every-15-minutes (*/15 * * * *) | every-30-minutes (*/30 * * * *) | hourly (0 * * * *) | daily (0 6 * * *) | weekly (0 6 * * 1) — or a raw 5-field cron (UTC). Required unless `clear: true`.' },
        enabled: { type: 'boolean', description: 'false keeps the config but deletes the schedule trigger (default true).' },
        clear: { type: 'boolean', description: 'true REMOVES the sync configuration entirely (the UI panel’s "Remove sync"): the schedule is dropped from os/schedules.yml, any pre-B2 CronJob is deleted, and no other field is read. Use `enabled: false` to keep the config and only stop the schedule.' },
      },
      required: ['datasetId'],
      examples: [
        { datasetId: 'ds_ab12cd', connectionId: 'conn_x1', source: { schema: 'sales', table: 'orders' }, mode: 'append', cursor: { column: 'updated_at', kind: 'timestamp' }, schedule: 'hourly' },
        { datasetId: 'ds_ab12cd', connectionId: 'conn_kj1', source: { schema: 'kajabi', table: 'purchases' }, mode: 'append', schedule: 'daily' },
        { datasetId: 'ds_ab12cd', clear: true },
      ],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('set_dataset_sync needs a `datasetId`', 400);
      // CLEARING (review M-1). The UI route passes `null` when the panel removes a sync
      // (`body.sync === null` → `saveDatasetSyncService(user, id, null)`); the MCP tool had no way
      // to say it, so an MCP client could create and change a sync but never remove one. `clear`
      // takes the same door: no other field is read, so a client need not echo a config back.
      if (bool(args.clear)) {
        const cleared = await saveDatasetSyncService(P(user), datasetId, null);
        return { datasetId, cleared: true, platform: cleared.platform, sync: cleared.sync, cron: cleared.cron };
      }
      // NOT a required-field pre-check: the EDIT GATE has to answer first, or a caller who may
      // not see the dataset learns "you forgot connectionId" instead of `forbidden` (X7's
      // documented shape). An incomplete config reaches the store's strict gate and gets its
      // precise 400 there, after the gate — exactly as the UI route's does.
      const src = (args.source ?? {}) as Record<string, unknown>;
      const cur = (args.cursor ?? {}) as Record<string, unknown>;
      // The SAME service the panel's PUT route calls (checklist X8): it enforces the
      // per-source mode/cursor locks at CONFIG time, delegates to the store's strict gate and
      // reconciles the schedule (Dagster owns it from the domain repo's os/schedules.yml).
      const out = await saveDatasetSyncService(P(user), datasetId, {
        connectionId: str(args.connectionId).trim(),
        source: { schema: str(src.schema).trim(), table: str(src.table).trim() },
        mode: str(args.mode) as DatasetSyncMode,
        ...(str(cur.column).trim()
          ? { cursor: { kind: str(cur.kind) === 'number' ? ('number' as const) : ('timestamp' as const), column: str(cur.column).trim() } }
          : {}),
        mergeKeys: strArr(args.mergeKeys),
        schedule: { cron: str(args.schedule).trim() },
        enabled: args.enabled === undefined ? true : bool(args.enabled),
      });
      return { datasetId, cleared: false, platform: out.platform, sync: out.sync, cron: out.cron };
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
      // The SAME service the panel's "Sync now" POST calls (checklist X8): the edit gate, then
      // one Dagster run from the committed head as the dataset OWNER (flag on) or the OS
      // executor and its ledger row (flag off).
      const ran = await syncDatasetNowService(P(user), datasetId, { reset: bool(args.reset) });
      if (ran.mode === 'dagster') {
        const l = ran.launch;
        if (l.launchError) fail(l.launchError, 502);
        return { skipped: false, source: 'dagster', run: { id: l.dagsterRunId, dagsterRunId: l.dagsterRunId, commit: l.commit, status: 'running', batchId: l.batchId ?? null }, selection: l.selection.map((k) => k.join('/')) };
      }
      const outcome = ran.outcome;
      if (!outcome.ok) fail(outcome.error, outcome.status);
      if (outcome.skipped) return { skipped: true, reason: outcome.reason, run: outcome.run ?? null };
      return { skipped: false, run: outcome.run };
    },
  },
  {
    name: 'reconcile_domain_tables',
    tab: 'data',
    minRole: 'builder',
    description:
      'SELF-HEAL the recurring "domain gold table not materialized" drift (#96 / #151): a promoted dataset whose registry says served (tier=asset, queryable, metric-ready) but whose PHYSICAL domain table `iceberg.<domain>.gold_<slug>` has vanished from the warehouse (a catalog/warehouse event, or a demote→re-promote round-trip) — so Dashboards and every metric read dead-end with "not materialized". This SWEEP enumerates the promoted domain tables you govern (optionally scoped to one `domain`), PROBES each physical Iceberg table, and RE-MATERIALIZES any that are MISSING or STALE by re-running the SAME stored publish CTAS the Data tab runs (source = the owner’s built Gold → target = the domain schema; preserves grain + measures — it re-runs the stored plan, never reconstructs). Best-effort per dataset (one failure never aborts the sweep) and IDEMPOTENT (a healthy, in-sync table is skipped — no CTAS re-run). Returns an honest per-dataset report {datasetId, name, fqn, before: missing|stale|ok, after: refreshed|failed|skipped, error?}. Governance: Builder+ heals their OWN domain (the domain-schema write floor); Admin heals every domain. Use after a warehouse re-provision, or when a dashboard reports a governed dataset "not materialized". The SAME sweep the governed route POST /api/platform-admin/reconcile-domain-tables runs.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional — scope the sweep to ONE domain (e.g. "agentic-leader-q3-2026"). Omit to sweep every domain you govern.' },
      },
      required: [],
      examples: [{}, { domain: 'agentic-leader-q3-2026' }],
    },
    call: async (user, args) => {
      const p = P(user);
      const domain = str(args.domain).trim();
      const report = await reconcileDomainTablesLive(p, domain ? { domain } : {});
      return report;
    },
  },
];

/**
 * The data write tools, as written.
 *
 * The per-tool `runWithSurface('mcp:<tool>')` wrapper that used to live here is GONE (Part D
 * review L-3): `core/mcp/server.ts` now opens that scope around EVERY `tools/call`, with the same
 * `mcp:<name>` value, so this layer was a second identical scope — harmless but redundant, and
 * redundant scoping is where a minted-second-request-id bug hides. One door, one scope.
 */
export const dataWriteTools: McpTool[] = tools;
