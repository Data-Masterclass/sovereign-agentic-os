/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session';
import type { McpTool, JsonSchema } from './server';

// --- Governed read/list lib functions (the EXACT same the UI + /api call) ------
import { listDatasets, getDataset } from '@/lib/data/store';
import { listWorkflows, getWorkflow } from '@/lib/knowledge/store';
import { listFiles, searchFiles, getFile } from '@/lib/files/store';
import { listMetrics } from '@/lib/metrics/store';
import { listDashboards, getDashboard } from '@/lib/dashboards/store';
import { listBets } from '@/lib/bigbets/store';
import { buildBetView } from '@/lib/bigbets/server';
import { getSystem } from '@/lib/agents/store';
import {
  listAppsForUser,
  getAppForUser,
  listAppFilesForViewer,
  readAppFileForViewer,
  templateFiles,
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
} from '@/lib/connections/openmetadata';
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
import type { Layer } from '@/lib/data/dataset-schema';
import { LAYERS } from '@/lib/data/dataset-schema';
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
import { listModelsForUser, type ModelViewer } from '@/lib/science/model-service';
import { CHURN, DEFAULT_FEATURES } from '@/lib/science/churn';

/**
 * The DISCOVERY tools — read-only adapters that make the OS legible so an AI
 * BUILDS ON WHAT EXISTS instead of re-creating it. Each is a THIN delegate over
 * the SAME governed lib function the UI calls, under the caller's delegated
 * identity, so OPA + document/row-level-security (mine/shared/marketplace
 * grouping) + Langfuse audit apply UNCHANGED. No privileged path here: identity
 * comes from the session, the role floor is re-checked in `handleRpc`, and the
 * governed fn is always the real authority.
 *
 * These mirror the dynamic `sovereign-os://my/*` resources one-for-one — the
 * deliberate redundancy so tools-only clients (ChatGPT, several runtimes) that
 * ignore MCP resources can still discover everything.
 */

type Principal = { id: string; domains: string[]; role: Role };
const P = (u: CurrentUser): Principal => ({ id: u.id, domains: u.domains, role: u.role });

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : [];

const NO_ARGS: JsonSchema = { type: 'object', properties: {}, examples: [{}] };
const idArg = (name: string, desc: string): JsonSchema => ({
  type: 'object',
  properties: { [name]: { type: 'string', description: desc } },
  required: [name],
  examples: [{ [name]: 'id_ab12cd' }],
});

/**
 * Resolve the physical FQN + medallion layer a granted dataset queries FOR the caller,
 * honouring the layer the agent's DATA grant selected (Gold is the serving default).
 *
 * Fail-graceful (never crash): {@link builtLayerFqn} resolves the requested layer when
 * it is built, otherwise the FURTHEST built layer — so a `silver` grant on a dataset
 * whose silver isn't built yet resolves to the best available and we FLAG the miss
 * (`requestedLayer` ≠ resolved `layer`, plus a note) rather than 404. When NOTHING is
 * built we surface {available:false} with an honest reason. Viewer-aware: the FQN's
 * schema and the read principal always agree (owner ⇒ personal lane, else domain).
 */
function resolveQueryable(
  d: ReturnType<typeof getDataset>,
  user: CurrentUser,
  requested?: Layer,
): {
  available: boolean;
  requestedLayer: Layer;
  layer?: Layer;
  fqn?: string;
  built: Layer[];
  note: string | null;
} {
  const requestedLayer: Layer = requested && LAYERS.includes(requested) ? requested : 'gold';
  const built = LAYERS.filter((l) => d.versions[l].built);
  const resolved = builtLayerFqn(d, P(user), requestedLayer);
  if (!resolved) {
    return {
      available: false,
      requestedLayer,
      built,
      note: `The ${requestedLayer} layer isn't built for this dataset yet — nothing to query.`,
    };
  }
  const fellBack = resolved.layer !== requestedLayer;
  return {
    available: true,
    requestedLayer,
    layer: resolved.layer,
    fqn: resolved.fqn,
    built,
    note: fellBack
      ? `The ${requestedLayer} layer isn't built yet — resolved to the furthest built layer (${resolved.layer}) instead.`
      : null,
  };
}

// ================================ READ / LIST =================================
const readTools: McpTool[] = [
  {
    name: 'list_datasets',
    tab: 'data',
    minRole: 'creator',
    description:
      'List the datasets you can see (yours · domain-shared · marketplace), grouped by tier. Path: DISCOVERY for the Data golden path (guide: sovereign-os://guide/path/data). Before: whoami. After: reuse an id with get_dataset / define_metric, or create_dataset only if nothing fits. Governance: read-only, DLS-scoped to your identity — you never see rows you are not entitled to.',
    inputSchema: NO_ARGS,
    call: async (user) => listDatasets(P(user)),
  },
  {
    name: 'get_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'Read one dataset you can see (medallion versions, docs, tier, data-quality rules) plus its semantic-layer state: `cube.ready` is true when the dataset is shared/certified AND its Gold is built — it is then AUTO-REGISTERED as a queryable Cube model (view `cube.view`, dimensions from the gold columns, count fallback) WITHOUT any define_metric step. `queryable` names the physical FQN + layer this dataset resolves to for YOU — Gold by default, or the medallion `layer` your data grant selects (bronze/silver). Path: DISCOVERY for the Data golden path. Before: list_datasets. After: add_dataset_version / document_dataset / define_quality_rules → run_quality_checks / define_metric (only to ADD measures — the model is already queryable). Governance: read-only; an id you cannot see returns not_found (no existence leak).',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id from list_datasets.' },
        layer: { type: 'string', enum: ['bronze', 'silver', 'gold'], description: 'Which medallion layer to resolve the queryable FQN for (default: your granted layer, else the furthest built — Gold is the serving default).' },
      },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd' }, { datasetId: 'ds_ab12cd', layer: 'silver' }],
    },
    call: async (user, args) => {
      const id = str(args.datasetId).trim();
      if (!id) fail('get_dataset needs a `datasetId`', 400);
      const d = getDataset(id, P(user));
      // Reflect the Cube auto-registration (the SAME gate cube-models delivers on):
      // shared/certified + Gold built ⇒ a queryable model appears in /api/cube/models
      // with no manual metric step. Kept honest — never claims ready before the gate.
      const ready = cubeDeliverable(d);
      // Which physical layer this dataset resolves to for the caller. The requested
      // layer comes from the agent's data grant (injected by the run path) or an
      // explicit arg; Gold is the serving default. Graceful fallback: if the requested
      // layer isn't built we resolve the furthest built one and SAY SO — never crash.
      const requested = (str(args.layer) as Layer) || undefined;
      const queryable = resolveQueryable(d, user, requested);
      return {
        ...d,
        queryable,
        cube: {
          ready,
          view: ready ? cubeViewName(d) : null,
          measures: d.measures.length ? d.measures.map((m) => m.name) : ['count'],
          note: ready
            ? 'Auto-registered as a Cube model on publish — queryable now (dimensions from the gold columns; add measures with define_metric).'
            : d.tier === 'dataset'
              ? 'Not yet: promote to a shared asset and build Gold first.'
              : 'Not yet: build the Gold layer first.',
        },
      };
    },
  },
  {
    name: 'profile_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'Profile one built medallion version of a dataset you can see — rowCount, per-column null%, distinct count, min/max (numeric/temporal), top values, and a small row preview. The same Explore profiler as the Data tab: the profiling SQL is generated server-side and run through the governed query path AS YOU, so OPA row filters + column masks apply (a masked column profiles the masked values — that is the point). Path: DISCOVERY for the physical Data golden path. Before: ingest_dataset (or any built layer). After: transform_silver with the real column names, or query_data for ad-hoc reads. Governance: read-only; an unseeable id → not_found; a version whose physical table is not queryable yet returns {available:false, reason} — never a fake profile.',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id from list_datasets.' },
        layer: { type: 'string', enum: ['bronze', 'silver', 'gold'], description: 'Which built layer to profile (default: the furthest built one).' },
      },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd', layer: 'bronze' }],
    },
    call: async (user, args) => {
      const id = str(args.datasetId).trim();
      if (!id) fail('profile_dataset needs a `datasetId`', 400);
      const dataset = getDataset(id, P(user)); // canView guard (403/404)

      const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];
      const requested = str(args.layer) as Layer;
      const built = LAYERS.filter((l) => dataset.versions[l].built);
      const layer = built.includes(requested) ? requested : built[built.length - 1];
      if (!layer) {
        return { datasetId: id, name: dataset.name, available: false, reason: 'Nothing built yet — bring in a Bronze version first (ingest_dataset).' };
      }

      // Viewer-aware FQN: the OWNER profiles their personal lane (which holds every
      // layer, promoted or not); a non-owner profiles the promoted copy in the domain
      // schema. The read PRINCIPAL must OWN that schema (readPrincipalFor's contract):
      // the owner's personal lane is read AS the owner, the domain copy AS the domain.
      const fqn = versionTarget(dataset, layer, { id: user.id });
      const isOwner = user.id === dataset.owner;
      const principal = isOwner ? user.id : (user.domains[0] ?? user.id);
      let columns: ProfileColumn[];
      try {
        columns = parseDescribe(await queryRun(`describe ${fqn}`, principal));
      } catch (e) {
        // Registered but not physically queryable (or the stack is offline) — answer
        // calmly with the honest reason rather than a crash.
        return { datasetId: id, name: dataset.name, layer, fqn, available: false, reason: `This ${layer} version isn't queryable right now (${(e as Error).message}).` };
      }
      const statsRes = await queryRun(statsSql(fqn, columns), principal);
      const previewRes = await queryRun(previewSql(fqn, 25), principal);
      // Top values are best-effort — a wide table or heavy scan never fails the profile.
      let topRes = null;
      if (columns.length > 0 && columns.length <= 40) {
        const sql = topValuesSql(fqn, columns, 5);
        if (sql) {
          try {
            topRes = await queryRun(sql, principal);
          } catch {
            topRes = null;
          }
        }
      }
      const profile = assembleProfile({ fqn, layer, columns, statsRes, topRes, previewRes });
      return { datasetId: id, name: dataset.name, available: true, ...profile };
    },
  },
  {
    name: 'list_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'List the knowledge workflows you can see (yours · domain · marketplace). Path: DISCOVERY for the Knowledge golden path (guide: sovereign-os://guide/path/knowledge). Before: whoami. After: get_knowledge, or search_knowledge for content. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listWorkflows(P(user)),
  },
  {
    name: 'get_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Read one knowledge workflow you can see (steps, rules, tacit, status). Path: DISCOVERY for the Knowledge golden path. Before: list_knowledge / search_knowledge. After: index_knowledge or (Builder) publish_knowledge. Governance: read-only; unseeable id → not_found.',
    inputSchema: idArg('workflowId', 'Workflow id from list_knowledge.'),
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('get_knowledge needs a `workflowId`', 400);
      return getWorkflow(id, P(user));
    },
  },
  {
    name: 'list_files',
    tab: 'files',
    minRole: 'creator',
    description:
      'List the files you can see (yours · domain · marketplace). Path: DISCOVERY for the Files golden path (guide: sovereign-os://guide/path/files). Before: whoami. After: search_files for content, or upload_file only if nothing fits. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listFiles(P(user)),
  },
  {
    name: 'search_files',
    tab: 'files',
    minRole: 'creator',
    description:
      'Semantic + lexical search over the files you are entitled to (restricted files are stored-not-indexed, so never surface). Path: DISCOVERY for the Files golden path. Before: list_files. After: reference a hit, or upload_file if absent. Governance: read-only; the same document-level grant filter as the Files tab.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to find.' } },
      required: ['query'],
      examples: [{ query: 'refund policy' }],
    },
    call: async (user, args) => {
      const query = str(args.query).trim();
      if (!query) fail('search_files needs a `query`', 400);
      return searchFiles(P(user), query);
    },
  },
  {
    name: 'list_metrics',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'List the governed metric members you can see (the one definition of every number). Path: DISCOVERY for the Metrics + Dashboards golden paths (guide: sovereign-os://guide/path/metrics). Before: whoami. After: reuse a member on a dashboard, or define_metric only if missing. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listMetrics(P(user)),
  },
  {
    name: 'query_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'EVALUATE a governed metric — resolve its canonical Cube member and return the number(s), optionally sliced by dimensions/time. This is how "what is revenue this month" resolves through the SEMANTIC LAYER, not raw SQL: no SQL is accepted or generated here BY CONSTRUCTION — the tool builds a Cube load query from the member, and Cube applies per-viewer row-level security from YOUR delegated identity (securityContext), exactly like the Metrics explorer and every dashboard. Two viewers get two different row sets; the number can never drift from the charts. Path: the read half of the Metrics golden path. Before: list_metrics (take a metric `id`, shaped `<datasetId>.<measure>`). After: chart the same member with create_dashboard, or wire it into an agent. Governance: read-only; a metric on a dataset you cannot see → not_found; offline the OS answers with the honestly-labelled offline-mock resolver (mode is always stated).',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: 'The metric id from list_metrics — `<datasetId>.<measure>`, e.g. "ds_ab12cd.revenue".' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Gold column names to slice by (become dimension members on the same view).' },
        timeDimension: { type: 'string', description: 'A time column to bucket by (use with granularity).' },
        granularity: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'], description: 'Time bucket for timeDimension.' },
        limit: { type: 'number', description: 'Max rows (default 100).' },
      },
      required: ['metricId'],
      examples: [
        { metricId: 'ds_ab12cd.revenue' },
        { metricId: 'ds_ab12cd.revenue', dimensions: ['region'], timeDimension: 'order_date', granularity: 'month' },
      ],
    },
    call: async (user, args) => {
      const metricId = str(args.metricId).trim();
      if (!metricId) fail('query_metric needs a `metricId` (from list_metrics, shaped `<datasetId>.<measure>`)', 400);
      // canView guard: getMetric resolves through getDataset (403/404 — no leak).
      const record = getMetric(metricId, P(user));
      // R2/R3: the load runs under YOUR delegated identity — the securityContext is
      // derived from the session claims (never a service account), so Cube's RLS is
      // the caller's. Same path as the Metrics explorer route.
      const token = delegate(claimsFromUser({ id: user.id, domains: user.domains, role: user.role }), 'domain');
      const result = await exploreMetric(record.dataset, record.measure, token, {
        dimensions: strArr(args.dimensions),
        timeDimension: str(args.timeDimension) || undefined,
        granularity: (str(args.granularity) as Granularity) || undefined,
        limit: typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined,
      });
      // The scalar: sum the member across returned rows (a grouped query still totals).
      let value: number | null = null;
      for (const row of result.rows) {
        const v = Number(row[result.member]);
        if (!Number.isNaN(v)) value = (value ?? 0) + v;
      }
      return { metricId, member: result.member, value, rows: result.rows, mode: result.mode, securityContext: result.securityContext };
    },
  },
  {
    name: 'list_dashboards',
    tab: 'dashboards',
    minRole: 'creator',
    description:
      'List the dashboards you can see (yours · domain · marketplace). Path: DISCOVERY for the Dashboards golden path (guide: sovereign-os://guide/path/dashboards). Before: whoami. After: create_dashboard, or attach one to a big bet. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listDashboards(P(user)),
  },
  {
    name: 'list_big_bets',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'List the Big Bets you can see (initiative roadmaps over real OS components). Path: DISCOVERY for the Big Bets golden path (guide: sovereign-os://guide/path/bigbets). Before: whoami + list_datasets/list_dashboards/list_agent_systems (the bet tracks REAL components). After: create_big_bet. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listBets(P(user)),
  },
  {
    name: 'get_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Read one agent system you can see (system.yaml, agents, grants, status). Path: DISCOVERY for the Agents golden path (guide: sovereign-os://guide/path/agents). Before: list_agent_systems. After: commit_agent_files / build_agent_system. Governance: read-only; unseeable id → not_found.',
    inputSchema: idArg('systemId', 'System id from list_agent_systems.'),
    call: async (user, args) => {
      const id = str(args.systemId).trim();
      if (!id) fail('get_agent_system needs a `systemId`', 400);
      return getSystem(id, P(user));
    },
  },
  {
    name: 'list_software',
    tab: 'software',
    minRole: 'creator',
    description:
      'List the apps you can see (yours · domain · shared). Path: DISCOVERY for the Software golden path (guide: sovereign-os://guide/path/software). Before: whoami. After: get_software, or create_software only if nothing fits. Governance: read-only, same visibility rule as the Software tab.',
    inputSchema: NO_ARGS,
    call: async (user) => listAppsForUser(user),
  },
  {
    name: 'get_software',
    tab: 'software',
    minRole: 'creator',
    description:
      'Read one app you can see (template, consumed resources, lifecycle state). Path: DISCOVERY for the Software golden path. Before: list_software. After: commit / start_preview / request_deploy. Governance: read-only; unseeable id → not_found.',
    inputSchema: idArg('appId', 'App id from list_software.'),
    call: async (user, args) => {
      const id = str(args.appId).trim();
      if (!id) fail('get_software needs an `appId`', 400);
      return getAppForUser(id, user);
    },
  },
];

// ====================== WAVE B — OPERATE & READ-BACK PARITY ===================
// Single-read + honest-status tools: an AI that cannot re-read its artifacts
// iterates blind. Each is a THIN delegate over the same governed single-get the
// UI calls, under the caller's identity — unseeable ids are typed not_found/
// forbidden, restricted content is metadata-only, and no URL is ever claimed
// that is not actually served.

/** Honest truncation caps: long content is cut with an explicit note, never silently. */
const FILE_TEXT_CAP = 8000;
const APP_FILE_CAP = 24000;

function truncated(text: string, cap: number): { text: string; note: string | null } {
  if (text.length <= cap) return { text, note: null };
  return {
    text: text.slice(0, cap),
    note: `Truncated: showing the first ${cap} of ${text.length} characters. Read the rest in the tab UI.`,
  };
}

const waveBReadTools: McpTool[] = [
  {
    name: 'get_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'Read ONE governed metric — its definition (aggregation + aggregated column), the gold dataset it is defined on, its tier + owner, the canonical Cube member every consumer resolves, and the generated Cube YAML. Purpose: read back exactly what define_metric registered so you iterate on the real definition instead of guessing. Before: list_metrics (take the `id`, shaped `<datasetId>.<measure>`). After: query_metric to evaluate the number, or create_dashboard to chart the member. Governance: read-only, resolved through the SAME dataset canView gate as list_metrics — a metric on a dataset you cannot see is a typed not_found/forbidden (no existence leak).',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: 'Metric id from list_metrics — `<datasetId>.<measure>`, e.g. "ds_ab12cd.revenue".' },
      },
      required: ['metricId'],
      examples: [{ metricId: 'ds_ab12cd.revenue' }],
    },
    call: async (user, args) => {
      const metricId = str(args.metricId).trim();
      if (!metricId) fail('get_metric needs a `metricId` (from list_metrics, shaped `<datasetId>.<measure>`)', 400);
      const r = getMetric(metricId, P(user)); // canView guard via getDataset (403/404)
      return {
        id: r.id,
        name: r.measure.name,
        member: r.member,
        tier: r.tier,
        owner: r.owner,
        datasetId: r.dataset.id,
        datasetName: r.dataset.name,
        definition: {
          aggregation: r.measure.type,
          column: r.measure.sql || null,
          // The sliceable dimensions come from the gold columns (cube_dbt contract).
          dimensions: r.dataset.columns.map((c) => c.name),
        },
        // Whether the dataset's Cube model is auto-registered + queryable (the SAME
        // shared+gold gate publish delivers on) — the measure resolves once ready.
        cubeReady: cubeDeliverable(r.dataset),
        cubeView: cubeDeliverable(r.dataset) ? cubeViewName(r.dataset) : null,
        cube: scaffoldCubeYaml(r.dataset),
      };
    },
  },
  {
    name: 'get_dashboard',
    tab: 'dashboards',
    minRole: 'creator',
    description:
      'Read ONE dashboard you can see — its charts with their governed metric members, the Cube view they bind to, tier and owner. Purpose: read back exactly what create_dashboard saved so you can iterate (create_dashboard with the same `id` replaces it) or attach it to a Big Bet. Before: list_dashboards. After: query_metric on a chart’s member to read the same number, or attach_component to put it on a bet. Governance: read-only, the SAME visibility rule as list_dashboards (yours · domain-shared · marketplace) — an unseeable id is a typed not_found/forbidden (no existence leak).',
    inputSchema: {
      type: 'object',
      properties: {
        dashboardId: { type: 'string', description: 'Dashboard id from list_dashboards.' },
      },
      required: ['dashboardId'],
      examples: [{ dashboardId: 'dash_sales_overview_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.dashboardId).trim();
      if (!id) fail('get_dashboard needs a `dashboardId` (from list_dashboards)', 400);
      const d = getDashboard(id, P(user)); // visibility guard (403/404)
      return {
        id: d.id,
        name: d.spec.name,
        view: d.spec.view,
        tier: d.tier,
        owner: d.owner,
        domain: d.domain,
        charts: d.spec.charts,
      };
    },
  },
  {
    name: 'get_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Read ONE Big Bet you can see — the problem + solution, pillar and north-star metric, the € target vs the REALIZED value (resolved RLS-scoped to YOU), the attached component references with their live derived status, completion and status. Purpose: the read-back half of the Big Bets golden path — progress is DERIVED from the components’ real lifecycle, never hand-set, so read it here instead of assuming. Before: list_big_bets. After: attach_component to grow the roadmap, update_big_bet to record the solution/status/realized value. Governance: read-only, the store’s own view scope (members + domain peers; cross-domain bets are members/Admin-only) — an unseeable id is a typed not_found/forbidden, and a not-yet-shared component’s detail is redacted to null for non-members (no governance shortcut).',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'Big Bet id from list_big_bets.' },
      },
      required: ['betId'],
      examples: [{ betId: 'bet_ab12cd34' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('get_big_bet needs a `betId` (from list_big_bets)', 400);
      const view = await buildBetView(betId, user); // canView guard (403/404), RLS-scoped value
      const { bet } = view;
      return {
        id: bet.id,
        name: bet.name,
        status: bet.status,
        domain: bet.domain,
        crossDomain: bet.crossDomain,
        owner: bet.owner,
        problem: bet.problem,
        solution: bet.solution ?? null,
        pillar: view.pillar,
        metric: view.metric,
        value: view.value.realized,
        goLive: bet.goLive,
        goLiveRealistic: view.roadmap.goLiveRealistic,
        signal: view.roadmap.signal,
        completion: view.completion,
        components: view.components.map((c) => ({
          refId: c.ref.id,
          artifactId: c.ref.artifactId,
          tab: c.ref.tab,
          plannedReady: c.ref.plannedReady,
          status: c.status,
          // Redacted to null when the viewer may not see a not-yet-shared component.
          artifact: c.artifact,
        })),
        canEdit: view.canEdit,
        sourceMode: view.sourceMode,
      };
    },
  },
  {
    name: 'get_file',
    tab: 'files',
    minRole: 'creator',
    description:
      'Read ONE governed file you are entitled to — metadata (name, folder, tags, description, sensitivity, tier, version history) plus the extracted text. Purpose: read back what upload_file stored so agents can quote the actual content, not a guess. Before: list_files or search_files. After: request_promotion once documented, or reference the content in knowledge/agent work. Governance: read-only through the SAME document-level entitlement filter (DLS) as the Files tab — an unentitled id is a typed not_found/forbidden. Honesty: `restricted` files return metadata ONLY (the text is stored but never returned or indexed), and long text is truncated at ~8k characters with an explicit note — never silently.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File id from list_files / search_files.' },
      },
      required: ['fileId'],
      examples: [{ fileId: 'as_ab12cd34' }],
    },
    call: async (user, args) => {
      const id = str(args.fileId).trim();
      if (!id) fail('get_file needs a `fileId` (from list_files / search_files)', 400);
      const v = getFile(id, P(user)); // DLS entitlement guard (403/404)
      const a = v.asset;
      const restricted = a.sensitivity === 'restricted';
      const body = restricted ? { text: null, note: 'This file is `restricted` — its text is stored but never returned or indexed. You see metadata only.' } : truncated(v.text, FILE_TEXT_CAP);
      return {
        id: a.id,
        name: a.name,
        owner: a.owner,
        domain: a.domain,
        tier: a.tier,
        visibility: a.visibility,
        folder: a.folder,
        tags: a.tags,
        description: a.description,
        sensitivity: a.sensitivity,
        kind: a.kind,
        indexing: a.indexing.mode,
        version: a.version,
        bytes: v.bytes,
        history: v.history,
        text: body.text,
        textNote: body.note,
      };
    },
  },
  {
    name: 'read_app_files',
    tab: 'software',
    minRole: 'creator',
    description:
      'Read an app’s FILE TREE — or one file’s content when `path` is given. The read-back counterpart of `commit`: what you committed is what you read. Purpose: iterate on the real code instead of re-guessing it. Before: list_software / get_software (you must be able to SEE the app — the same gate). After: commit changed files, start_preview, get_software_status. Governance: read-only under YOUR identity; an unseeable app is a typed not_found (no existence leak). Honesty: reads the live Forgejo repo when reachable (mode "live"); otherwise the last tree committed through the governed commit door — or the template seed for a fresh app — honestly labelled mode "offline-mock". Large files are truncated at ~24k characters with an explicit note.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
        path: { type: 'string', description: 'Optional file path — returns that file’s content instead of the tree.' },
      },
      required: ['appId'],
      examples: [{ appId: 'app_ab12cd34' }, { appId: 'app_ab12cd34', path: 'app.yaml' }],
    },
    call: async (user, args) => {
      const appId = str(args.appId).trim();
      if (!appId) fail('read_app_files needs an `appId` (from list_software)', 400);
      const path = str(args.path).trim();
      const app = await getAppForUser(appId, user); // visibility guard (404)
      if (await forgejoReachable()) {
        if (!path) {
          const t = await listAppFilesForViewer(appId, user);
          return { appId, mode: 'live', branch: t.branch, files: t.files };
        }
        const f = await readAppFileForViewer(appId, user, path);
        const body = truncated(f.content, APP_FILE_CAP);
        return { appId, mode: 'live', path: f.path, content: body.text, contentNote: body.note, sha: f.sha };
      }
      // Offline: the last tree committed through the governed commit door (or the
      // template seed for a fresh app) — labelled honestly, never a fabrication.
      const tree = getSnapshot(app.id) ?? templateFiles(app.template, app.name, app.slug);
      const note = 'Forgejo is unreachable — this is the app’s last governed-commit tree (or the template seed for a fresh app), labelled offline-mock.';
      if (!path) {
        return { appId, mode: 'offline-mock', branch: 'main', files: tree.map((f) => f.path).sort((a, b) => a.localeCompare(b)), note };
      }
      const f = tree.find((x) => x.path === path);
      if (!f) fail(`File not found in the app tree: ${path}`, 404);
      const body = truncated(f.content, APP_FILE_CAP);
      return { appId, mode: 'offline-mock', path: f.path, content: body.text, contentNote: body.note, note };
    },
  },
  {
    name: 'get_software_status',
    tab: 'software',
    minRole: 'creator',
    description:
      'Read ONE app’s HONEST status card: preview state (with a URL only when a runner actually serves one — never fabricated), deploy state (requested / approved / denied, with the reviewer and note), release count, the build pipeline stages and the last governed commit. Purpose: the single read that tells you where an app truly is in create → preview → review → live, so you never act on a claimed-but-not-served URL. Before: list_software / get_software. After: start_preview or request_deploy (or fix and re-commit after a denial). Governance: read-only, the same visibility gate as get_software — an unseeable app is a typed not_found. Honesty rule, enforced: `preview.url` and `deploy.liveUrl` are null unless the workload is actually served; a pending runner or an offline cluster is SAID, not papered over.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
      },
      required: ['appId'],
      examples: [{ appId: 'app_ab12cd34' }],
    },
    call: async (user, args) => {
      const appId = str(args.appId).trim();
      if (!appId) fail('get_software_status needs an `appId` (from list_software)', 400);
      const app = await getAppForUser(appId, user); // visibility guard (404)
      const openCard = app.deploy.reviewCardId ? getReviewCard(app.deploy.reviewCardId) : null;
      const latest = openCard ?? listReviewCards({ domain: app.domain }).find((c) => c.appId === app.id) ?? null;
      const isLive = app.deploy.state === 'live';
      // NEVER claim a working URL that is not actually served: live state alone is
      // not enough — the pipeline must be ok AND the app created against a live stack.
      const liveServed = isLive && app.pipeline.live === 'ok' && app.mode === 'live';
      const lastCommit = [...app.chat].reverse().find((m) => m.role === 'assistant' && m.content.startsWith('Committed:')) ?? null;
      return {
        appId: app.id,
        name: app.name,
        status: app.status,
        mode: app.mode,
        preview: {
          state: app.deploy.state,
          url: app.deploy.previewUrl,
          ...(app.deploy.previewUrl ? {} : { note: PREVIEW_PENDING_NOTE }),
        },
        deploy: {
          state: app.deploy.state,
          releases: app.deploy.releases,
          approvedEnvelope: app.deploy.approved,
          review: latest
            ? {
                cardId: latest.id,
                decision: latest.decision,
                requestedBy: latest.requestedBy,
                requestedAt: latest.requestedAt,
                decidedBy: latest.decidedBy ?? null,
                note: latest.note ?? null,
              }
            : null,
          liveUrl: liveServed ? `https://${app.subdomain}` : null,
          ...(isLive && !liveServed
            ? { liveUrlNote: 'Approved to go live, but no cluster runner serves it here — so no URL is claimed.' }
            : {}),
        },
        build: {
          pipeline: app.pipeline,
          repo: app.repo.fullName,
          repoUrl: app.repo.htmlUrl,
          lastCommit: lastCommit ? { message: lastCommit.content, at: lastCommit.at } : null,
          updatedAt: app.updatedAt,
        },
      };
    },
  },
];

// ================================ CONNECTIONS =================================
// Connections becomes a real MCP tab. create/test are creator (the lib re-gates
// SHARED service-credential templates to Builder/Admin); promote is Builder+.
// ONE source of truth: the keys create_connection accepts are derived from the
// SAME CONNECTION_TEMPLATES registry the lib validates against (templateByKey).
const connectionTemplateKeys: ConnectionTemplateKey[] = CONNECTION_TEMPLATES.map((t) => t.key);

const connectionTools: McpTool[] = [
  {
    name: 'list_connection_templates',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List what CAN be connected — the connection template catalog: each template’s key, label, what it connects (Drive / Database / API / MCP / SaaS), whether it is PERSONAL (per-user OAuth — any user may connect their own account) or SHARED (service credentials — creating it needs a Builder/Admin), the endpoint hint, the fields create_connection needs, and the safe preset capability profile (reads on · writes opt-in · deletes blocked). Purpose: step 0 of the Connections golden path — know the catalog before you connect. Before: whoami. After: list_connections (reuse first!), then create_connection with a template key from here. Governance: read-only and identical for every role; this reads the SAME template registry create_connection validates against, so a key listed here is always accepted there (one source of truth).',
    inputSchema: NO_ARGS,
    call: async () => ({
      templates: CONNECTION_TEMPLATES
        // The `warehouse` template appears ONLY when the operator enabled external
        // connectors — otherwise it is hidden exactly like it is in the UI picker.
        .filter((t) => t.key !== 'warehouse' || config.externalConnectorsEnabled)
        // Same for the external `om-catalog` template — hidden until an operator
        // enables OPENMETADATA_CONNECT_ENABLED (Phase 1 default OFF).
        .filter((t) => t.key !== 'om-catalog' || config.openmetadataConnectEnabled)
        .map((t) => {
          const personal = isPersonalConnectable(t);
          return {
            key: t.key,
            label: t.label,
            connects: t.type,
            connector: t.connector,
            auth: t.auth,
            personal,
            minRoleToCreate: personal ? 'creator' : 'builder',
            endpointHint: t.endpointHint,
            requiredFields: ['name', 'template'],
            optionalFields: [
              'endpoint (defaults to the endpointHint)',
              `credential (the ${t.secretKey} — stored server-side, fingerprinted, never returned)`,
              'domain (one of YOUR domains; defaults to your first)',
            ],
            tools: t.tools.map((x) => ({ name: x.name, write: x.write, mode: x.mode })),
          };
        }),
      // The external-warehouse platforms + each provider's credential fields, so a
      // tools-only client can build the `warehouse` block for create_connection. Only
      // present when enabled; the field split (secret vs record) is provider-driven.
      warehouse: config.externalConnectorsEnabled
        ? {
            enabled: true,
            note: 'Create a warehouse connection with template="warehouse" and a warehouse block {platform, catalog, fields}. Fields render from the provider below; secret-keyed fields go to Secrets Manager, the rest onto the record. Live registration is an operator GitOps step (values.trino.externalCatalogs + rolling restart).',
            platforms: WAREHOUSE_PLATFORMS.map((p) => {
              const pr = WAREHOUSE_PROVIDERS[p];
              return {
                platform: pr.platform,
                label: pr.label,
                capabilities: pr.capabilities,
                fields: pr.credentialFields.map((f) => ({
                  key: f.key,
                  label: f.label,
                  required: f.required,
                  secret: pr.secretMaterial.secretKeys.includes(f.key),
                })),
                liveVerificationRequired: pr.liveVerificationRequired,
              };
            }),
          }
        : { enabled: false as const },
      note: 'PERSONAL (per-user OAuth) templates are connectable by any user; SHARED (service-credential) templates require a Builder/Admin — create_connection re-gates this in the lib.',
    }),
  },
  {
    name: 'list_connections',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the connections you can see (personal + shared data sources). Path: step 1 (reuse!) of the Connections golden path (guide: sovereign-os://guide/path/connections). Before: whoami. After: get_connection, or create_connection only if nothing fits. Governance: read-only, DLS-scoped — you never see another user’s personal connection.',
    inputSchema: NO_ARGS,
    call: async (user) => listConnectionsForUser(user),
  },
  {
    name: 'get_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read one connection you can see (template, endpoint, tier, sync state — NEVER the raw credential). Path: DISCOVERY for the Connections golden path. Before: list_connections. After: test_connection, or consume it from an app via use_connection BY REFERENCE. Governance: read-only; unseeable id → not_found.',
    inputSchema: idArg('connId', 'Connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_connection needs a `connId`', 400);
      return getConnectionForUser(id, user);
    },
  },
  {
    name: 'create_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Create a PERSONAL connection to a data source (per-user OAuth). Path: step 2 of the Connections golden path. Before: list_connections (reuse first). After: test_connection, then Builder promote_connection to share. Governance: any user may connect a personal account; SHARED (service-credential) templates require a Builder/Admin (the lib re-gates). The credential is stored server-side—the model never sees it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human name for the connection.' },
        template: { type: 'string', enum: connectionTemplateKeys, description: 'Connection template (adapter family).' },
        endpoint: { type: 'string', description: 'Endpoint/URL (defaults to the template hint).' },
        credential: { type: 'string', description: 'Secret/token — stored server-side, fingerprinted, never returned.' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        warehouse: {
          type: 'object',
          description: 'For template="warehouse" ONLY (external connectors must be enabled): the federation config. Secret-keyed fields go to Secrets Manager, the rest onto the record.',
          properties: {
            platform: { type: 'string', enum: [...WAREHOUSE_PLATFORMS], description: 'Warehouse platform (from list_connection_templates.warehouse.platforms).' },
            catalog: { type: 'string', description: 'Trino catalog name to mount as, e.g. glue_sales ([a-z_][a-z0-9_]*).' },
            fields: { type: 'object', description: 'Flat field map keyed by the provider credential-field keys (e.g. {region:"eu-central-1"}).' },
          },
          required: ['platform', 'catalog', 'fields'],
        },
        omService: {
          type: 'string',
          description: 'For template="om-catalog" ONLY (OpenMetadata connections must be enabled): the optional default OM Service name. The endpoint is the OM base URL; credential is the bot JWT.',
        },
        airflow: {
          type: 'object',
          description: 'For template="airflow" ONLY: the non-secret REST config. The endpoint is the Airflow base URL; credential is the Bearer token (or the Basic-auth password).',
          properties: {
            authType: { type: 'string', enum: ['basic', 'bearer'], description: 'How to authenticate (default bearer).' },
            username: { type: 'string', description: 'Basic-auth username (non-secret); omit for bearer.' },
            dagAllowlist: { type: 'array', items: { type: 'string' }, description: 'Optional DAG ids trigger_dag is bounded to (empty = any DAG).' },
          },
        },
      },
      required: ['name', 'template'],
      examples: [
        { name: 'Ops MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/sse', credential: 'secret_xxx' },
        { name: 'Glue sales', template: 'warehouse', warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } } },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_connection needs a `name`', 400);
      const template = str(args.template) as ConnectionTemplateKey;
      if (!connectionTemplateKeys.includes(template)) fail('create_connection needs a valid `template`', 400);
      let warehouse: WarehouseCreateInput | undefined;
      if (template === 'warehouse') {
        const w = (args.warehouse ?? {}) as Record<string, unknown>;
        const platform = str(w.platform) as WarehousePlatform;
        if (!WAREHOUSE_PLATFORMS.includes(platform)) fail('warehouse connection needs a valid `warehouse.platform`', 400);
        const catalog = str(w.catalog).trim();
        const rawFields = (w.fields && typeof w.fields === 'object') ? (w.fields as Record<string, unknown>) : {};
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawFields)) fields[k] = str(v);
        warehouse = { platform, catalog, fields };
      }
      let airflow: AirflowCreateInput | undefined;
      if (template === 'airflow') {
        const a = (args.airflow ?? {}) as Record<string, unknown>;
        const authType = (str(a.authType) === 'basic' ? 'basic' : 'bearer') as AirflowAuthType;
        airflow = { authType, username: str(a.username) || undefined, dagAllowlist: strArr(a.dagAllowlist) };
      }
      return createConnection(user, {
        name,
        template,
        endpoint: str(args.endpoint),
        credential: str(args.credential),
        domain: str(args.domain) || undefined,
        warehouse,
        omService: template === 'om-catalog' ? str(args.omService) || undefined : undefined,
        airflow,
      });
    },
  },
  {
    name: 'test_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Test a connection you can see — returns live | offline + a detail string. Path: step 3 of the Connections golden path. Before: create_connection. After: Builder promote_connection, or consume it from an app. Governance: read-only probe under your identity; unseeable id → not_found.',
    inputSchema: idArg('connId', 'Connection id to test.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('test_connection needs a `connId`', 400);
      return testConnection(id, user);
    },
  },
  {
    name: 'promote_connection',
    tab: 'connections',
    minRole: 'domain_admin',
    description:
      'Promote a Personal connection → a SHARED domain data source (Domain admin+ only — the creator/builder lockdown). Path: step 4 of the Connections golden path. Before: create_connection + test_connection. After: apps in the domain consume it via use_connection BY REFERENCE. Governance: Domain admin/Admin; re-promoting an already-shared connection returns a conflict.',
    inputSchema: idArg('connId', 'Personal connection id you own to promote.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('promote_connection needs a `connId`', 400);
      // Route the flip through the ONE effect seam (never promoteConnection directly).
      const r = await promoteThroughSeam('connection', id, user);
      return getConnectionForUser(id, user).then((c) => ({ id: c.id, name: c.name, visibility: c.visibility, applied: r.applied, live: r.live }));
    },
  },
];

// External-warehouse tools — registered ONLY when the operator enabled external
// connectors. `warehouse_registration` returns the GitOps values snippet an operator
// applies to register the catalog in Trino (read-only-rootfs → no runtime catalog
// creation); `import_warehouse_table` materializes one federated table into the OS
// Iceberg lakehouse via the SAME governed CTAS path promote/materialize uses.
const warehouseTools: McpTool[] = [
  {
    name: 'warehouse_registration',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Get the GitOps registration for a WAREHOUSE connection you can see — the Trino catalog `.properties`, the secret env vars it references, the OpenMetadata connector hint, and the exact `values.trino.externalCatalogs` YAML entry an operator pastes. Purpose: registration is a values edit + rolling restart (the Trino pod mounts its catalog dir read-only, so no runtime catalog creation) — this returns what to apply. Before: create_connection (template="warehouse"). After: an operator applies the snippet + wires the secret + rolling-restarts Trino, then test_connection. Governance: read-only; unseeable id → not_found. Secrets are referenced via ${ENV:...}, never emitted.',
    inputSchema: idArg('connId', 'Warehouse connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('warehouse_registration needs a `connId`', 400);
      return warehouseRegistration(id, user);
    },
  },
  {
    name: 'discover_warehouse_tables',
    tab: 'connections',
    minRole: 'creator',
    description:
      'DISCOVER a registered warehouse catalog’s schemas — and, given a `schema`, its tables — through the SAME governed query path test_connection probes (SHOW SCHEMAS / SHOW TABLES run AS your domain, so Trino→OPA governs the reads). Purpose: browse what is federated before import_warehouse_table, without guessing names. Before: create_connection (warehouse) + register the catalog so it is queryable. After: import_warehouse_table with a real schema.table. Governance: read-only; unseeable id → not_found. Honest: a catalog that is not registered/queryable yet, or a platform with no metastore (Fabric/OneLake), returns ok:false + a reason — never an invented listing.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Warehouse connection id from list_connections.' },
        schema: { type: 'string', description: 'Optional schema to list tables from (omit for schemas only).' },
      },
      required: ['connId'],
      examples: [{ connId: 'conn_ab12cd' }, { connId: 'conn_ab12cd', schema: 'sales' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('discover_warehouse_tables needs a `connId`', 400);
      return discoverWarehouse(id, user, { schema: str(args.schema) || undefined });
    },
  },
  {
    name: 'register_warehouse_catalog',
    tab: 'connections',
    minRole: 'builder',
    description:
      'ONE-CLICK REGISTER a warehouse connection as a LIVE Trino catalog — no YAML paste, no manual helm. Merges the connection’s catalog `.properties` into the live trino-catalog ConfigMap, materializes its vaulted secret(s) into a trino-ext-<catalog> Secret + wires the Trino env (keyless platforms like Glue/BigQuery-WI emit NO secret), and rolls the Trino Deployment (Recreate re-reads the mount). Before: create_connection (warehouse). After: test_connection / discover_warehouse_tables once the pod restarts. Governance: Builder/Admin with edit rights on the connection; audit-logged. Honest: a step the API server rejects returns ok:false with the real reason — never a silent partial. Secrets are read server-side and never returned.',
    inputSchema: idArg('connId', 'Warehouse connection id you can edit.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('register_warehouse_catalog needs a `connId`', 400);
      return registerWarehouseCatalog(id, user);
    },
  },
  {
    name: 'import_warehouse_table',
    tab: 'connections',
    minRole: 'creator',
    description:
      'IMPORT one federated external table into the OS Iceberg lakehouse as an owned data product — a governed CTAS (CREATE TABLE iceberg.<domain>.<name> AS SELECT * FROM <catalog>.<schema>.<table>) run through the SAME promote/materialize path (Trino→OPA as you). This is distinct from marketplace import_product (a listing GRANT): here you materialize a live external table. Before: create_connection (warehouse) + register the catalog + test_connection so the catalog is queryable. After: the imported table is a normal sovereign dataset. Governance: requires edit rights on the connection; the query-tool re-validates the CTAS allowlist + target-schema/role gate before Trino runs it.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Warehouse connection id from list_connections.' },
        schema: { type: 'string', description: 'Source schema in the external catalog.' },
        table: { type: 'string', description: 'Source table to import.' },
        name: { type: 'string', description: 'Target table name (defaults to the source table name).' },
        targetDomain: { type: 'string', description: 'One of YOUR domains to land it in (defaults to the connection domain).' },
      },
      required: ['connId', 'schema', 'table'],
      examples: [{ connId: 'conn_ab12cd', schema: 'sales', table: 'orders' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('import_warehouse_table needs a `connId`', 400);
      const schema = str(args.schema).trim();
      const table = str(args.table).trim();
      if (!schema || !table) fail('import_warehouse_table needs a `schema` and a `table`', 400);
      return importWarehouseTable(id, user, { schema, table, name: str(args.name) || undefined, targetDomain: str(args.targetDomain) || undefined });
    },
  },
];

// ============================ EXTERNAL OPENMETADATA ===========================
// Read/discover tools over an EXTERNAL OpenMetadata modelled as an `om-catalog`
// connection (Phase 1). Registered ONLY when the operator enabled
// OPENMETADATA_CONNECT_ENABLED. Every tool is READ-ONLY — there is NO write to OM
// here (the scoped write path is Phase 2). Each resolves the connection under the
// caller's identity (DLS 404 on an unseeable id), reads the bot JWT server-side
// (never returned/logged), and routes through the governed spine so calls are
// audit-traced like every other discovery tool. An unreachable OM degrades to an
// honest { ok:false, reason } — never a fabricated listing.
const omArg = (extra?: Record<string, unknown>): JsonSchema => ({
  type: 'object',
  properties: {
    connId: { type: 'string', description: 'The om-catalog connection id from list_connections.' },
    ...(extra ?? {}),
  },
  required: ['connId', ...Object.keys(extra ?? {})],
  examples: [{ connId: 'conn_ab12cd', ...(extra ? Object.fromEntries(Object.keys(extra).map((k) => [k, 'x'])) : {}) }],
});

const omCatalogTools: McpTool[] = [
  {
    name: 'list_domains',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the DOMAINS in an external OpenMetadata catalog (om-catalog connection). Read-only discovery — OM domain membership is a discovery SIGNAL, not an authorization boundary. Before: list_connections (find an om-catalog connection). After: list_data_products / list_tables / search_catalog. Governance: read-only; an unseeable connId → not_found; an unreachable OM → { ok:false, reason }.',
    inputSchema: omArg(),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_domains needs a `connId`', 400);
      const c = await resolveOmCatalog(id, user);
      return omListDomains(c);
    },
  },
  {
    name: 'list_data_products',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the DATA PRODUCTS in an external OpenMetadata catalog (om-catalog connection). Read-only discovery. Before: list_connections. After: list_tables / search_catalog / get_om_lineage. Governance: read-only; unseeable connId → not_found; unreachable OM → { ok:false, reason }.',
    inputSchema: omArg(),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_data_products needs a `connId`', 400);
      const c = await resolveOmCatalog(id, user);
      return omListDataProducts(c);
    },
  },
  {
    name: 'list_tables',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List TABLES (with description/owners/tags) in an external OpenMetadata catalog (om-catalog connection). Read-only discovery. Before: list_connections. After: search_catalog to narrow, or get_om_lineage on a table FQN. Governance: read-only; unseeable connId → not_found; unreachable OM → { ok:false, reason }.',
    inputSchema: omArg(),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_tables needs a `connId`', 400);
      const c = await resolveOmCatalog(id, user);
      return omListTables(c);
    },
  },
  {
    name: 'search_catalog',
    tab: 'connections',
    minRole: 'creator',
    description:
      'SEARCH an external OpenMetadata catalog (om-catalog connection) by free text. Read-only discovery. Before: list_connections. After: get_om_lineage on a hit’s FQN. Governance: read-only; unseeable connId → not_found; unreachable OM → { ok:false, reason }.',
    inputSchema: omArg({ query: { type: 'string', description: 'Free-text search over the OM catalog.' } }),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('search_catalog needs a `connId`', 400);
      const query = str(args.query).trim();
      if (!query) fail('search_catalog needs a `query`', 400);
      const c = await resolveOmCatalog(id, user);
      return omSearch(c, query);
    },
  },
  {
    name: 'get_om_lineage',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read LINEAGE for an entity in an external OpenMetadata catalog (om-catalog connection) by FQN. Read-only. Before: list_tables / search_catalog (take an FQN). Governance: read-only; unseeable connId → not_found; unreachable OM or unknown FQN → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The om-catalog connection id from list_connections.' },
        fqn: { type: 'string', description: 'Entity fully-qualified name, e.g. "trino.iceberg.sales.orders".' },
        entity: { type: 'string', description: 'Entity type (default "table").' },
      },
      required: ['connId', 'fqn'],
      examples: [{ connId: 'conn_ab12cd', fqn: 'trino.iceberg.sales.orders' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_om_lineage needs a `connId`', 400);
      const fqn = str(args.fqn).trim();
      if (!fqn) fail('get_om_lineage needs an `fqn`', 400);
      const c = await resolveOmCatalog(id, user);
      return omLineage(c, fqn, str(args.entity) || undefined);
    },
  },
  {
    name: 'preview_om_sync',
    tab: 'connections',
    minRole: 'creator',
    description:
      'PREVIEW the additive, integrity-safe write-back of one OS dataset/product into an external OpenMetadata (om-catalog connection) — READ-ONLY (Guard 6, dry-run). Computes the EXACT PUT bodies (into the dedicated `sovereign_os` Service / `Sovereign OS Products` Domain), JSON-Patch ops (additive `add`/`replace`/`test` only — NEVER `remove`), and lineage edges, then renders an honest diff ("will create N entities … touch ZERO human fields"). NOTHING is written. Before: list_connections (an om-catalog connection) + list_datasets (a promoted asset/product with Gold built). After: apply_om_sync (held for approval). Governance: read-only; unseeable connId/datasetId → not_found; a dataset that is not a promoted asset/product or has no built Gold is rejected with the reason.',
    inputSchema: omArg({
      datasetId: { type: 'string', description: 'The OS dataset/product id from list_datasets (must be a promoted asset/product with Gold built).' },
      humanServiceFqn: { type: 'string', description: 'Optional: the customer OM Trino Service name whose catalogued copy of the mart should be ADDITIVELY annotated (tag + managedBy props). Omit to annotate no human table.' },
    }),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('preview_om_sync needs a `connId`', 400);
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('preview_om_sync needs a `datasetId`', 400);
      const c = await resolveOmCatalog(id, user); // DLS 404 on an unseeable connection
      const d = getDataset(datasetId, P(user)); // canView guard (403/404)
      return previewOmSyncForConnection(c, d, {
        runId: `preview_${Date.now().toString(36)}`,
        humanServiceFqn: str(args.humanServiceFqn) || undefined,
      });
    },
  },
  {
    name: 'apply_om_sync',
    tab: 'connections',
    minRole: 'creator',
    description:
      'APPLY the additive write-back of one OS dataset/product into an external OpenMetadata (om-catalog connection). This is a real WRITE side effect — its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab and returns "requires_approval"; only once approved does the OS write. The write is additive-only and integrity-safe by construction: it PUT-creates ONLY inside the dedicated `sovereign_os` Service / `Sovereign OS Products` Domain, stamps `managedBy=SovereignOS`, emits NO `remove` op ever, writes a description only when empty (behind a `test` precondition), and YIELDS (records a conflict) on any human edit since the last OS sync. Re-sync is idempotent (a no-op). The plan is RECOMPUTED server-side from the datasetId on approval — the held item cannot smuggle a wider write. Before: preview_om_sync (see the exact diff). Governance: Write-approval; the writer bot token is separate + least-privilege (OM Role scoped to the OS namespace); unseeable connId/datasetId → not_found.',
    inputSchema: omArg({
      datasetId: { type: 'string', description: 'The OS dataset/product id to write back (from list_datasets).' },
      humanServiceFqn: { type: 'string', description: 'Optional: the customer OM Trino Service name whose mart copy is additively annotated. Omit to annotate no human table.' },
    }),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('apply_om_sync needs a `connId`', 400);
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('apply_om_sync needs a `datasetId`', 400);
      const c = await resolveOmCatalog(id, user); // DLS 404 on an unseeable connection
      const d = getDataset(datasetId, P(user)); // canView guard (403/404)
      const humanServiceFqn = str(args.humanServiceFqn) || undefined;
      // Preview-first, ALWAYS: reject an unbuildable plan with the honest reason before
      // ever queueing a write (never enqueue a no-op or an unsafe request).
      const preview = previewOmSyncForConnection(c, d, { runId: 'plan', humanServiceFqn });
      if (!preview.ok) fail(preview.rejected ?? 'This dataset cannot be synced to OpenMetadata.', 400);

      // Guard 6 — HOLD for human approval (Write-approval). The effect that runs on
      // approval recomputes the plan server-side and executes it through the writer bot.
      const approval = enqueue({
        kind: 'connection_write',
        title: `Write-back "${d.name}" → OpenMetadata (${c.name})`,
        detail: preview.summary,
        agent: user.id,
        domain: d.domain,
        requestedBy: user.id,
        tool: 'apply_om_sync',
        approverRole: 'builder',
        scope: 'domain',
        source: 'Connections',
        payload: { connId: c.id, datasetId: d.id, humanServiceFqn: humanServiceFqn ?? null },
        preview: {
          what: preview.summary,
          who: `Sovereign OS writer bot (least-privilege, scoped to the ${'sovereign_os'} namespace)`,
          why: `Additively publish the OS ${d.tier} into the external catalog for discovery + lineage.`,
          impact: `${preview.counts.creates} create/update, ${preview.counts.patches} additive annotation(s), ${preview.counts.edges} lineage edge(s); ZERO human fields touched.`,
          diff: preview.lines.join('\n'),
        },
      });
      return {
        decision: 'requires_approval',
        approvalId: approval.id,
        summary: preview.summary,
        note: 'Held for human approval in the Governance tab (Write-approval). The write runs only once approved; the plan is recomputed server-side on approval.',
      };
    },
  },
];

// ================================= AIRFLOW =====================================
// Governed outbound tools over a customer's Apache Airflow modelled as an `airflow`
// connection. list_dags / get_dag_run are Read (auto-allow); trigger_dag is a real
// side effect held for approval by default (its CapabilityMode is Write-approval).
// Every tool routes through the SAME governed callConnectionTool as the UI + the
// /api tool door — so the capability gate, the DAG allowlist bound, the vaulted
// secret injection (never returned/logged) and the Langfuse audit ALL apply, and a
// held trigger is enqueued into the Governance queue rather than firing.
const airflowTools: McpTool[] = [
  {
    name: 'list_dags',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the DAGs in a customer Apache Airflow (airflow connection). Read-only monitoring — the credential is injected server-side and never returned. Before: list_connections (find an airflow connection). After: trigger_dag to start a run, or get_dag_run to monitor one. Governance: read-only, auto-allowed; an unseeable connId → not_found; an unreachable Airflow → { ok:false, reason }.',
    inputSchema: idArg('connId', 'The airflow connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_dags needs a `connId`', 400);
      return callConnectionTool(id, user, { tool: 'list_dags', args: {} });
    },
  },
  {
    name: 'get_dag_run',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read one DAG run (state, logical date) in a customer Apache Airflow (airflow connection) by dag id + run id. Read-only monitoring. Before: list_dags / trigger_dag (take the returned dagRunId). Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown run → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id returned by trigger_dag.' },
      },
      required: ['connId', 'dagId', 'runId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_dag_run needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      if (!dagId || !runId) fail('get_dag_run needs a `dagId` and a `runId`', 400);
      return callConnectionTool(id, user, { tool: 'get_dag_run', args: { dagId, runId } });
    },
  },
  {
    name: 'trigger_dag',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Trigger a DAG run in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (a Builder can drop it to Write-bounded once trusted). The response decision is "requires_approval" until approved; only then does Airflow receive the POST. `conf` is passed through to the run. Before: list_dags (pick a dagId). After: get_dag_run to monitor. Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id to trigger, e.g. "example_etl".' },
        conf: { type: 'object', description: 'Optional run configuration passed to the DAG (Airflow `conf`).' },
        logicalDate: { type: 'string', description: 'Optional ISO-8601 logical date for the run.' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }, { connId: 'conn_ab12cd', dagId: 'example_etl', conf: { rows: 100 } }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('trigger_dag needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('trigger_dag needs a `dagId`', 400);
      const toolArgs: Record<string, unknown> = { dagId };
      if (args.conf && typeof args.conf === 'object') toolArgs.conf = args.conf;
      if (str(args.logicalDate).trim()) toolArgs.logicalDate = str(args.logicalDate).trim();
      return callConnectionTool(id, user, { tool: 'trigger_dag', args: toolArgs });
    },
  },
  // ---- Reads (auto-allowed) — deeper monitoring of runs, tasks, XCom + assets. ----
  {
    name: 'list_dag_runs',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List a DAG’s run history in a customer Apache Airflow (airflow connection), optionally filtered by run state. Read-only monitoring — the credential is injected server-side and never returned. Before: list_dags (pick a dagId). After: get_dag_run / get_task_instances to drill into a run. Governance: read-only, auto-allowed; an unseeable connId → not_found; an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        limit: { type: 'number', description: 'Optional max runs to return (most recent first).' },
        state: { type: 'string', description: 'Optional run-state filter, e.g. "success", "failed", "running".' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }, { connId: 'conn_ab12cd', dagId: 'example_etl', state: 'failed', limit: 5 }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_dag_runs needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('list_dag_runs needs a `dagId`', 400);
      const toolArgs: Record<string, unknown> = { dagId };
      if (args.limit !== undefined) toolArgs.limit = Number(args.limit);
      if (str(args.state).trim()) toolArgs.state = str(args.state).trim();
      return callConnectionTool(id, user, { tool: 'list_dag_runs', args: toolArgs });
    },
  },
  {
    name: 'get_task_instances',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read the task-level status of one DAG run in a customer Apache Airflow (airflow connection) — which tasks ran, succeeded or failed. Read-only monitoring. Before: list_dag_runs / get_dag_run (take the returned dagRunId). After: get_task_logs to read a failed task’s log, or clear_task to retry it. Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown run → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id (from trigger_dag / list_dag_runs).' },
      },
      required: ['connId', 'dagId', 'runId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_task_instances needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      if (!dagId || !runId) fail('get_task_instances needs a `dagId` and a `runId`', 400);
      return callConnectionTool(id, user, { tool: 'get_task_instances', args: { dagId, runId } });
    },
  },
  {
    name: 'get_task_logs',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Fetch one task attempt’s log text (truncated for output) in a customer Apache Airflow (airflow connection). Read-only monitoring — the credential is injected server-side and never returned. Before: get_task_instances (find the failing taskId). Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown task → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id (from list_dag_runs).' },
        taskId: { type: 'string', description: 'The task id inside the run (from get_task_instances).' },
        tryNumber: { type: 'number', description: 'Optional attempt number (defaults to the latest try).' },
      },
      required: ['connId', 'dagId', 'runId', 'taskId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00', taskId: 'extract' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_task_logs needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      const taskId = str(args.taskId).trim();
      if (!dagId || !runId || !taskId) fail('get_task_logs needs a `dagId`, `runId` and `taskId`', 400);
      const toolArgs: Record<string, unknown> = { dagId, runId, taskId };
      if (args.tryNumber !== undefined) toolArgs.tryNumber = Number(args.tryNumber);
      return callConnectionTool(id, user, { tool: 'get_task_logs', args: toolArgs });
    },
  },
  {
    name: 'get_xcom',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read a task’s XCom entry (a small return value / pointer, not a dataset) in a customer Apache Airflow (airflow connection). Read-only monitoring. XCom holds SMALL values — large outputs land in a warehouse the OS reads via its warehouse connectors. Before: get_task_instances (find the taskId). Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown key → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id (from list_dag_runs).' },
        taskId: { type: 'string', description: 'The task id inside the run (from get_task_instances).' },
        key: { type: 'string', description: 'Optional XCom key (defaults to the task’s return value).' },
      },
      required: ['connId', 'dagId', 'runId', 'taskId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00', taskId: 'extract' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_xcom needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      const taskId = str(args.taskId).trim();
      if (!dagId || !runId || !taskId) fail('get_xcom needs a `dagId`, `runId` and `taskId`', 400);
      const toolArgs: Record<string, unknown> = { dagId, runId, taskId };
      if (str(args.key).trim()) toolArgs.key = str(args.key).trim();
      return callConnectionTool(id, user, { tool: 'get_xcom', args: toolArgs });
    },
  },
  {
    name: 'list_datasets',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the data-driven assets/datasets in a customer Apache Airflow (airflow connection) — Airflow’s data-aware scheduling surface (v2 "assets" ↔ v1 "datasets"). Read-only monitoring — the credential is injected server-side and never returned. After: get_dataset_events to see which task last updated an asset. Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        limit: { type: 'number', description: 'Optional max assets/datasets to return.' },
      },
      required: ['connId'],
      examples: [{ connId: 'conn_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_datasets needs a `connId`', 400);
      const toolArgs: Record<string, unknown> = {};
      if (args.limit !== undefined) toolArgs.limit = Number(args.limit);
      return callConnectionTool(id, user, { tool: 'list_datasets', args: toolArgs });
    },
  },
  {
    name: 'get_dataset_events',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List asset/dataset update events in a customer Apache Airflow (airflow connection) — which producing task updated which asset, and when. Read-only monitoring. Before: list_datasets. Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        limit: { type: 'number', description: 'Optional max events to return (most recent first).' },
      },
      required: ['connId'],
      examples: [{ connId: 'conn_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_dataset_events needs a `connId`', 400);
      const toolArgs: Record<string, unknown> = {};
      if (args.limit !== undefined) toolArgs.limit = Number(args.limit);
      return callConnectionTool(id, user, { tool: 'get_dataset_events', args: toolArgs });
    },
  },
  // ---- Control (Write-approval — real side effects, HELD for Governance; honor dagAllowlist). ----
  {
    name: 'pause_dag',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Pause a DAG so it stops scheduling in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (response decision "requires_approval" until approved). The connection’s `dagAllowlist` is honoured: a DAG not on the allowlist is refused. Before: list_dags (pick a dagId). Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id to pause, e.g. "example_etl".' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('pause_dag needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('pause_dag needs a `dagId`', 400);
      return callConnectionTool(id, user, { tool: 'pause_dag', args: { dagId } });
    },
  },
  {
    name: 'unpause_dag',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Unpause a DAG so it resumes scheduling in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (response decision "requires_approval" until approved). The connection’s `dagAllowlist` is honoured. Before: list_dags (pick a dagId). Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id to unpause, e.g. "example_etl".' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('unpause_dag needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('unpause_dag needs a `dagId`', 400);
      return callConnectionTool(id, user, { tool: 'unpause_dag', args: { dagId } });
    },
  },
  {
    name: 'clear_task',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Clear (retry/rerun) task instances of a DAG run in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (response decision "requires_approval" until approved). The connection’s `dagAllowlist` is honoured. Optionally scope to specific `taskIds` and/or only failed tasks. Before: get_task_instances (find the failed taskIds). Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id whose tasks to clear (from list_dag_runs).' },
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Optional specific task ids to clear (default: all tasks in the run).' },
        onlyFailed: { type: 'boolean', description: 'Optional — clear only failed task instances.' },
      },
      required: ['connId', 'dagId', 'runId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00', onlyFailed: true }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('clear_task needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      if (!dagId || !runId) fail('clear_task needs a `dagId` and a `runId`', 400);
      const toolArgs: Record<string, unknown> = { dagId, runId };
      if (Array.isArray(args.taskIds)) toolArgs.taskIds = (args.taskIds as unknown[]).map(String);
      if (args.onlyFailed !== undefined) toolArgs.onlyFailed = Boolean(args.onlyFailed);
      return callConnectionTool(id, user, { tool: 'clear_task', args: toolArgs });
    },
  },
];

// ================================= SCIENCE ====================================
// The Science read surface: what the caller can SCORE through the governed predict
// door. Reads the SAME registry `science_predict`'s gate (`authorizePredict`) reads,
// RLS-scoped with `listModelsForUser` — so list/get and predict can never disagree.

/** The model card shape both science tools return (never the raw model). */
function modelCard(m: ReturnType<typeof listModelsForUser>[number]) {
  const production = m.versions.find((v) => v.stage === 'Production') ?? m.versions[0];
  return {
    model: m.model,
    name: m.name,
    owner: m.owner,
    domain: m.domain,
    tier: m.tier,
    stage: m.stage,
    frontDoors: m.frontDoors,
    consumptionMode: m.consumptionMode,
    versions: m.versions,
    metrics: production ? { version: production.version, auc: production.auc, certified: production.certified } : null,
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

const scienceTools: McpTool[] = [
  {
    name: 'list_models',
    tab: 'science',
    minRole: 'creator',
    description:
      'List the ML models YOU can score through the governed predict door — your own Personal models, your domain’s, and Marketplace-certified ones (the same tier ladder as every artifact; promoting a model is what widens who may call it). Path: step 1 of the Science golden path (guide: sovereign-os://guide/path/science). Before: whoami. After: get_model for one card, then science_predict. Governance: read-only, RLS-scoped to your identity — another user’s Personal model never appears. Honest: when ml.enabled=false the response SAYS SO (predict will 404 until an Admin enables it); an empty tenant returns an empty list, never an invented model.',
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
      'Read one model’s card: features, default feature vector, score bands/threshold, registry versions + metrics (AUC), tier (who may call it) and serving status (stage, front doors, ml.enabled). Path: step 2 of the Science golden path. Before: list_models. After: science_predict with the card’s feature names. Governance: read-only; a model outside your tier scope → not_found (no existence leak) — the same visibility rule `science_predict`’s gate enforces.',
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

// =================================== META =====================================
const guideTool: McpTool = {
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

export const DISCOVERY_TOOLS: McpTool[] = [
  ...readTools,
  ...waveBReadTools,
  ...connectionTools,
  // Warehouse tools appear ONLY when the operator enabled external connectors —
  // nothing new surfaces on the MCP when EXTERNAL_CONNECTORS_ENABLED is off.
  ...(config.externalConnectorsEnabled ? warehouseTools : []),
  // External-OM read tools appear ONLY when the operator enabled OpenMetadata
  // connections — nothing new surfaces when OPENMETADATA_CONNECT_ENABLED is off.
  ...(config.openmetadataConnectEnabled ? omCatalogTools : []),
  // Airflow tools are always available — the connector is user-facing (a plain API
  // connector); the tools resolve to a no-op unless an airflow connection exists.
  ...airflowTools,
  ...scienceTools,
  guideTool,
];
