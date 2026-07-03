/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import type { Role } from '@/lib/session';
import type { McpTool, JsonSchema } from './server';

// --- Governed lib functions (the EXACT same the UI + /api routes call) ---------
import {
  createDataset,
  buildVersion,
  setDocs as setDatasetDocs,
  requestPromotion as requestDatasetPromotion,
  applyApprovedPromotion as applyApprovedDatasetPromotion,
  getDataset,
  defineMeasure,
} from '@/lib/data/store';
import { canBuildStage, canPassThrough, stageArtifact } from '@/lib/data/panels';
import { scaffoldCubeYaml } from '@/lib/data/metrics';
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc } from '@/lib/data/dataset-schema';
import { measureFromForm, measureMember, type MetricForm } from '@/lib/metrics/model';
import type { MeasureType } from '@/lib/data/metrics';

import {
  createWorkflow,
  updateWorkflow,
  publishWorkflow,
  getWorkflow,
  getDomainKnowledge,
} from '@/lib/knowledge/store';
import {
  serializeWorkflow,
  parseWorkflow,
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
} from '@/lib/knowledge/schema';
import { indexWorkflow, indexDomain } from '@/lib/knowledge/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
} from '@/lib/files/store';
import { reindexFile } from '@/lib/files/pipeline-server';
import type { Sensitivity } from '@/lib/files/asset-schema';

import { saveDashboard } from '@/lib/dashboards/store';
import { fromTiles, type ChartSpec } from '@/lib/dashboards/model';

import { createBet, type CreateBetInput } from '@/lib/bigbets/store';
import { deriveBetName } from '@/lib/bigbets/model';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
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
      'Build one medallion version (bronze→silver→gold) of a dataset you can edit — the guided panel’s “Confirm”. Pass an authored dbt-SQL `body` for silver/gold, or `passThrough:true` to carry the prior layer forward. The prior layer must exist first.',
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
      return buildVersion(datasetId, p, layer, {
        quality: (str(args.quality) as Quality) || undefined,
        passThrough,
        artifact: passThrough ? null : stageArtifact(current.name, layer),
        body: passThrough ? undefined : (typeof args.body === 'string' ? args.body : undefined),
      });
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
    name: 'promote_dataset',
    tab: 'data',
    minRole: 'builder',
    description:
      'Promote your documented dataset from Personal → a governed DOMAIN asset (into Trino). Builder+ only (the creator lockdown): a creator cannot self-promote. Reuses the SAME request→approve seam as the UI (request as owner, apply as the domain Builder). Idempotency: re-promoting an already-promoted dataset returns a `conflict`.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset you own and have documented (silver/gold built).' },
        visibility: { type: 'string', description: 'Requested asset visibility (default domain).' },
        grants: { type: 'array', description: 'Optional explicit policy grants (else a domain read grant).' },
      },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd', visibility: 'domain' }],
    },
    call: async (user, args) => {
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('promote_dataset needs a `datasetId`', 400);
      const p = P(user);
      const req = requestDatasetPromotion(datasetId, p, {
        visibility: (str(args.visibility) as DataVisibility) || undefined,
        grants: (args.grants as Grant[]) || undefined,
      });
      const dataset = applyApprovedDatasetPromotion(req, p);
      return { promoted: true, target: req.target, dataset };
    },
  },
];

// ============================== KNOWLEDGE ======================================
export const knowledgeWriteTools: McpTool[] = [
  {
    name: 'author_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Author a Personal (draft) knowledge workflow — the operating manual for a task: an optional markdown body, ordered `steps` (each with an actor), and workflow `rules`. Same governed store as the Knowledge tab. Publish it later with `publish_knowledge`.',
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
            },
            required: ['title'],
          },
        },
        rules: {
          type: 'array',
          description: 'Workflow decision rules.',
          items: { type: 'object', properties: { text: { type: 'string' }, hard: { type: 'boolean' } }, required: ['text'] },
        },
      },
      required: ['title'],
      examples: [
        {
          title: 'Refund handling',
          domain: 'support',
          steps: [
            { title: 'Verify order', actor: 'Human', outputs: ['Verified order'] },
            { title: 'Issue refund', actor: 'Software', inputs: ['Verified order'] },
          ],
          rules: [{ text: 'Refunds over 500 EUR need a manager', hard: true }],
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
        // serializeWorkflow emits frontmatter + step blocks; splice the prose body
        // back in right after the frontmatter so it round-trips through the store.
        let md = serializeWorkflow(w);
        if (body) md = md.replace(/^(---\n[\s\S]*?\n---\n\n)/, `$1${body}\n\n`);
        updateWorkflow(rec.id, p, { md });
      }
      return { id: rec.id, title: rec.title, domain: rec.domain, status: rec.status, visibility: rec.visibility };
    },
  },
  {
    name: 'publish_knowledge',
    tab: 'knowledge',
    minRole: 'builder',
    description:
      'Publish a draft workflow Personal → Shared (draft→live) and re-index it for retrieval. Builder+ only (the creator lockdown mirrors publishWorkflow). Idempotency: publishing an already-live workflow returns a `conflict`.',
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
      const rec = publishWorkflow(id, p);
      try {
        const wf = parseWorkflow(rec.md);
        await indexWorkflow(wf, { owner: rec.owner, tacit: rec.tacit, updatedAt: rec.updatedAt });
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
  {
    name: 'promote_file',
    tab: 'files',
    minRole: 'builder',
    description:
      'Promote your documented file Personal → a DOMAIN asset (re-governs the object-store prefix + DLS). Builder+ only (the creator lockdown). Reuses the SAME request→approve seam as the UI. Idempotency: re-promoting returns a `conflict`.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File you own (owner + description + ≥1 tag documented).' },
        visibility: { type: 'string', description: 'Requested asset visibility (default domain).' },
        grants: { type: 'array', description: 'Optional explicit policy grants.' },
      },
      required: ['fileId'],
      examples: [{ fileId: 'file_ab12cd', visibility: 'domain' }],
    },
    call: async (user, args) => {
      const fileId = str(args.fileId).trim();
      if (!fileId) fail('promote_file needs a `fileId`', 400);
      const p = P(user);
      const req = requestFilePromotion(fileId, p, {
        visibility: (str(args.visibility) as DataVisibility) || undefined,
        grants: (args.grants as Grant[]) || undefined,
      });
      const asset = applyApprovedFilePromotion(req, p);
      return { promoted: true, target: req.target, asset };
    },
  },
];

// =============================== METRICS ======================================
export const metricWriteTools: McpTool[] = [
  {
    name: 'define_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Define a governed metric on a dataset’s built GOLD version — the one definition of a number (Cube member). The dataset must already be a governed asset/product (promote it in Data first). Returns the canonical member + the generated Cube YAML.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Gold, governed (asset/product) dataset id.' },
        name: { type: 'string', description: 'Human metric name, e.g. "Revenue".' },
        aggregation: { type: 'string', enum: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'number'], description: 'The aggregation.' },
        column: { type: 'string', description: 'Gold column to aggregate (empty for count).' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Dimensions the metric can be sliced by.' },
      },
      required: ['datasetId', 'name', 'aggregation'],
      examples: [{ datasetId: 'ds_ab12cd', name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['order_date', 'region'] }],
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
      const measure = measureFromForm(form);
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
];

export const ALL_WRITE_TOOLS: McpTool[] = [
  ...dataWriteTools,
  ...knowledgeWriteTools,
  ...fileWriteTools,
  ...metricWriteTools,
  ...dashboardWriteTools,
  ...bigbetWriteTools,
  ...agentWriteTools,
];

// Keep an explicit reference to JsonSchema so the imported type is used (schemas above
// are structurally JsonSchema; this makes the dependency intentional + tree-checked).
export type WriteToolSchema = JsonSchema;
