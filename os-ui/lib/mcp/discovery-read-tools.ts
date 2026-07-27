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
import {
  consecutiveErrorCount,
  currentWatermark,
  ensureSyncRunsHydrated,
  isQuarantined,
  lastMaintenanceAt,
  listSyncRuns,
} from '@/lib/data/sync-runs';
import { nextCronRun } from '@/lib/data/sync-next-run';

// ================================ READ / LIST =================================
export const readTools: McpTool[] = [
  {
    name: 'list_datasets',
    tab: 'data',
    minRole: 'creator',
    description:
      'List the datasets you can see (My · Domain · Company), grouped by tier (also called: table, data product). Path: DISCOVERY for the Data golden path (guide: sovereign-os://guide/path/data). Before: whoami. After: reuse an id with get_dataset / define_metric, or create_dataset only if nothing fits. Governance: read-only, DLS-scoped to your identity — you never see rows you are not entitled to.',
    inputSchema: NO_ARGS,
    call: async (user) => listDatasets(P(user)),
  },
  {
    name: 'get_dataset',
    tab: 'data',
    minRole: 'creator',
    description:
      'Read one dataset you can see (also called: table, data product) — medallion versions, docs, tier, data-quality rules — plus its semantic-layer state: `cube.ready` is true when the dataset is shared/certified AND its Gold is built — it is then AUTO-REGISTERED as a queryable Cube model (view `cube.view`, dimensions from the gold columns, count fallback) WITHOUT any define_metric step. `queryable` names the physical FQN + layer this dataset resolves to for YOU — Gold by default, or the medallion `layer` your data grant selects (bronze/silver). Path: DISCOVERY for the Data golden path. Before: list_datasets. After: add_dataset_version / document_dataset / define_quality_rules → run_quality_checks / define_metric (only to ADD measures — the model is already queryable). Governance: read-only; an id you cannot see returns not_found (no existence leak).',
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
    name: 'get_sync_status',
    tab: 'data',
    minRole: 'creator',
    description:
      'Read a dataset’s SCHEDULED-SYNC state (also called: refresh, data pipeline, ETL) — the same payload as GET /api/data/datasets/:id/sync: the saved config (mode, cursor, schedule, enabled), the source connection’s platform (kafka/salesforce/kajabi/warehouse — the per-source lock context), the estimated `nextRunAt` (UTC; null when the sync is disabled or the cron isn’t a simple preset shape — an honest omission, never a guess), the recent run history newest-first (per run: status ok|error|skipped|running, rowsAffected, cursor window, batchId, the honest error message), the current cursor `watermark` (cursorAfter of the latest ok run; null = never synced), and the QUARANTINE state (≥10 trailing consecutive errors auto-pauses scheduled runs; any successful run — e.g. sync_dataset_now — clears it, no flag to reset). Path: the read half of the sync loop. Before: set_dataset_sync. After: sync_dataset_now to run/resume, or set_dataset_sync to adjust. Governance: read-only, DLS-scoped like get_dataset — an unseeable id is not_found (no existence leak); an unresolvable connection reports platform:null honestly rather than failing the read.',
    inputSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string', description: 'Dataset id from list_datasets.' } },
      required: ['datasetId'],
      examples: [{ datasetId: 'ds_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.datasetId).trim();
      if (!id) fail('get_sync_status needs a `datasetId`', 400);
      const d = getDataset(id, P(user)); // canView gate (403/404 — no leak)
      await ensureSyncRunsHydrated().catch(() => {});
      // The source connection's PLATFORM (same mapping as the sync status route).
      // Best-effort: an unresolvable connection is an honest null, never a failed read.
      let platform: string | null = null;
      if (d.sync) {
        try {
          const c = await getConnectionForUser(d.sync.connectionId, user);
          platform =
            c.template === 'warehouse' && c.warehouse
              ? c.warehouse.platform
              : c.template === 'salesforce-api'
                ? 'salesforce'
                : c.template === 'kajabi-api'
                  ? 'kajabi'
                  : null;
        } catch {
          platform = null;
        }
      }
      const next = d.sync?.enabled ? nextCronRun(d.sync.schedule.cron, new Date()) : null;
      return {
        datasetId: id,
        name: d.name,
        sync: d.sync ?? null,
        platform,
        nextRunAt: next ? next.toISOString() : null,
        runs: listSyncRuns(id).slice(-20).reverse(), // newest first, same window as the UI
        watermark: currentWatermark(id),
        quarantined: isQuarantined(id),
        consecutiveErrors: consecutiveErrorCount(id),
        lastMaintenanceAt: lastMaintenanceAt(id),
      };
    },
  },
  {
    name: 'list_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'List the knowledge business processes you can see (also called: workflows, process workflows, SOPs (Standard Operating Procedures)) — My · Domain · Company. Path: DISCOVERY for the Knowledge golden path (guide: sovereign-os://guide/path/knowledge). Before: whoami. After: get_knowledge, or search_knowledge for content. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listWorkflows(P(user)),
  },
  {
    name: 'get_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Read one knowledge business process (also called: workflow, process workflow, SOP (Standard Operating Procedure)) you can see — steps, rules, tacit, status. Path: DISCOVERY for the Knowledge golden path. Before: list_knowledge / search_knowledge. After: index_knowledge or (Builder) publish_knowledge. Governance: read-only; unseeable id → not_found.',
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
      'List the files you can see (My · Domain · Company). Path: DISCOVERY for the Files golden path (guide: sovereign-os://guide/path/files). Before: whoami. After: search_files for content, or upload_file only if nothing fits. Governance: read-only, DLS-scoped.',
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
      'List the governed metric members you can see (also called: KPIs, measures, indicators) — the one definition of every number. Path: DISCOVERY for the Metrics + Dashboards golden paths (guide: sovereign-os://guide/path/metrics). Before: whoami. After: reuse a member on a dashboard, or define_metric only if missing. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listMetrics(P(user)),
  },
  {
    name: 'query_metric',
    tab: 'metrics',
    minRole: 'creator',
    description:
      'EVALUATE a governed metric (also called: KPI, measure, indicator) — resolve its canonical Cube member and return the number(s), optionally sliced by dimensions/time. This is how "what is revenue this month" resolves through the SEMANTIC LAYER, not raw SQL: no SQL is accepted or generated here BY CONSTRUCTION — the tool builds a Cube load query from the member, and Cube applies per-viewer row-level security from YOUR delegated identity (securityContext), exactly like the Metrics explorer and every dashboard. Two viewers get two different row sets; the number can never drift from the charts. Path: the read half of the Metrics golden path. Before: list_metrics (take a metric `id`, shaped `<datasetId>.<measure>`). After: chart the same member with create_dashboard, or wire it into an agent. Governance: read-only; a metric on a dataset you cannot see → not_found; offline the OS answers with the honestly-labelled offline-mock resolver (mode is always stated).',
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
      'List the dashboards you can see (also called: reports, business intelligence (BI), data visualizations) — My · Domain · Company. Path: DISCOVERY for the Dashboards golden path (guide: sovereign-os://guide/path/dashboards). Before: whoami. After: create_dashboard, or attach one to a big bet. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listDashboards(P(user)),
  },
  {
    name: 'list_big_bets',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'List the Big Bets you can see (also called: initiatives, strategic investments, projects) — roadmaps over real OS components. Path: DISCOVERY for the Big Bets golden path (guide: sovereign-os://guide/path/bigbets). Before: whoami + list_datasets/list_dashboards/list_agent_systems (the bet tracks REAL components). After: create_big_bet. Governance: read-only, DLS-scoped.',
    inputSchema: NO_ARGS,
    call: async (user) => listBets(P(user)),
  },
  {
    name: 'get_agent_system',
    tab: 'agents',
    minRole: 'creator',
    description:
      'Read one agent system (also called: AI team, assistant team) you can see — system.yaml, agents, grants, status. Path: DISCOVERY for the Agents golden path (guide: sovereign-os://guide/path/agents). Before: list_agent_systems. After: commit_agent_files / build_agent_system. Governance: read-only; unseeable id → not_found.',
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
      'List the apps you can see (My · Domain · Company). Each app includes `purpose` (Define stage intent), `epics` (Design epics + stories), and `grants` (capability metadata — kind/level only, never raw credentials). Path: DISCOVERY for the Software golden path (guide: sovereign-os://guide/path/software). Before: whoami. After: get_software, or create_software only if nothing fits. Governance: read-only, same visibility rule as the Software tab.',
    inputSchema: NO_ARGS,
    call: async (user) => {
      const apps = await listAppsForUser(user);
      return apps.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        purpose: a.purpose,
        epics: a.epics,
        grants: a.grants,
        template: a.template,
        surface: a.surface,
        owner: a.owner,
        domain: a.domain,
        visibility: a.visibility,
        status: a.status,
        deploy: a.deploy,
        updatedAt: a.updatedAt,
        createdAt: a.createdAt,
      }));
    },
  },
  {
    name: 'get_software',
    tab: 'software',
    minRole: 'creator',
    description:
      'Read one app you can see (template, consumed resources, lifecycle state, plus `purpose` / `epics` / `grants`). `grants` is capability metadata (kind + access level) — never raw credentials. Path: DISCOVERY for the Software golden path. Before: list_software. After: commit / start_preview / request_deploy / set_app_design. Governance: read-only; unseeable id → not_found.',
    inputSchema: idArg('appId', 'App id from list_software.'),
    call: async (user, args) => {
      const id = str(args.appId).trim();
      if (!id) fail('get_software needs an `appId`', 400);
      const a = await getAppForUser(id, user);
      return {
        id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        purpose: a.purpose,
        epics: a.epics,
        grants: a.grants,
        template: a.template,
        surface: a.surface,
        declaredSurface: a.declaredSurface,
        owner: a.owner,
        domain: a.domain,
        visibility: a.visibility,
        mode: a.mode,
        repo: a.repo,
        subdomain: a.subdomain,
        pipeline: a.pipeline,
        designDecisions: a.designDecisions,
        dataDescriptions: a.dataDescriptions,
        docs: a.docs,
        manifest: a.manifest,
        mcpTools: a.mcpTools,
        consumes: a.consumes,
        status: a.status,
        deploy: a.deploy,
        usedAsData: a.usedAsData,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
    },
  },
];

