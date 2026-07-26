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

export const omCatalogTools: McpTool[] = [
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
  {
    name: 'sync_quality_to_catalog',
    tab: 'connections',
    minRole: 'creator',
    description:
      'PUSH the OS-authored DATA-QUALITY of one dataset into an external OpenMetadata (om-catalog connection) as first-class TestSuites / TestCases — the DQ leg of the additive, integrity-safe write-back. This is a real WRITE side effect: CapabilityMode Write-approval, so the call is HELD for human approval in the Governance tab and returns "requires_approval"; only once approved does the OS write. It first renders a dry-run PREVIEW (the exact Basic TestSuite + one TestCase per rule under the dedicated `sovereign_os` namespace, managedBy=SovereignOS, additive-only, idempotent) and rejects an unbuildable plan (no built Gold / not promoted / no executable rule) with the honest reason BEFORE queueing anything. Governed per-run results then trend into OM automatically. GATED by openmetadata.dqWriteback.enabled + the fail-closed OM version range; if OM is unreachable or out of range the write is refused honestly — the OS-side DQ always still runs. Before: preview via this same tool (it previews first). Governance: Write-approval; writer bot is least-privilege, scoped to the OS namespace; unseeable connId/datasetId → not_found.',
    inputSchema: omArg({
      datasetId: { type: 'string', description: 'The OS dataset id whose DQ rules to publish (from list_datasets; a promoted asset/product with Gold built and at least one executable rule).' },
    }),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('sync_quality_to_catalog needs a `connId`', 400);
      const datasetId = str(args.datasetId).trim();
      if (!datasetId) fail('sync_quality_to_catalog needs a `datasetId`', 400);
      const c = await resolveOmCatalog(id, user); // DLS 404 on an unseeable connection
      const d = getDataset(datasetId, P(user)); // canView guard (403/404)
      // Preview-first, ALWAYS: reject an unbuildable DQ plan with the honest reason before
      // ever queueing a write (never enqueue a no-op or an unsafe request).
      const preview = previewDqSyncForConnection(c, d, { runId: 'plan' });
      if (!preview.ok) fail(preview.rejected ?? 'This dataset has no data-quality to sync to OpenMetadata.', 400);

      // Guard 6 — HOLD for human approval (Write-approval), reusing the connection_write
      // effect. The effect recomputes the plan server-side and writes via the writer bot.
      const approval = enqueue({
        kind: 'connection_write',
        title: `Sync DQ "${d.name}" → OpenMetadata (${c.name})`,
        detail: preview.summary,
        agent: user.id,
        domain: d.domain,
        requestedBy: user.id,
        tool: 'sync_quality_to_catalog',
        approverRole: 'builder',
        scope: 'domain',
        source: 'Connections',
        payload: { connId: c.id, datasetId: d.id },
        preview: {
          what: preview.summary,
          who: `Sovereign OS writer bot (least-privilege, scoped to the ${'sovereign_os'} namespace)`,
          why: `Additively publish the OS data-quality rules as OM TestSuites/TestCases so OM's DQ dashboard + Incident Manager reflect OS-governed DQ.`,
          impact: `${preview.counts.suites} TestSuite, ${preview.counts.testCases} TestCase(s); ZERO human fields touched.`,
          diff: preview.lines.join('\n'),
        },
      });
      return {
        decision: 'requires_approval',
        approvalId: approval.id,
        summary: preview.summary,
        note: 'Held for human approval in the Governance tab (Write-approval). The DQ write runs only once approved; the plan is recomputed server-side on approval.',
      };
    },
  },
  {
    name: 'refresh_catalog',
    tab: 'connections',
    minRole: 'domain_admin',
    description:
      'REFRESH the external OpenMetadata catalog (#147) so it reflects the LIVE governed lakehouse — a BULK, additive, integrity-safe write-back over EVERY governed gold/silver mart the caller may see (DLS-scoped), in one governed pass. It folds the SAME metadata (tables/columns/lineage) + DQ (TestSuites/TestCases, when enabled) write-back the per-dataset tools use, so all seven guards + the fail-closed OM version range apply UNCHANGED: it PUT-creates ONLY inside the dedicated `sovereign_os` Service / `Sovereign OS Products` Domain, stamps managedBy=SovereignOS, emits NO `remove` op ever, and touches ZERO human fields. GATED by OPENMETADATA_INGEST_ENABLED; requires a visible om-catalog connection. This is a real WRITE side effect: CapabilityMode Write-approval, so the call renders a dry-run PREVIEW across all marts and is HELD for human approval, returning "requires_approval"; the plan is recomputed server-side on approval. OM unreachable / off-range / a leg disabled → that mart is an honest no-op (never fabricated success, never blocks). Cross-namespace upstream lineage over the customer\'s own Trino tables is handled by OM\'s native crawl (the openmetadata-trino-ingestion CronJob).',
    inputSchema: {
      type: 'object',
      properties: {
        humanServiceFqn: { type: 'string', description: 'Optional: the customer OM Trino Service name whose catalogued copies of the marts are ADDITIVELY annotated (tag + managedBy props). Omit to annotate no human table.' },
      },
      required: [],
      examples: [{}, { humanServiceFqn: 'trino' }],
    },
    call: async (user, args) => {
      if (!config.openmetadataIngestEnabled) {
        fail('Catalog ingestion is disabled (OPENMETADATA_INGEST_ENABLED is not true).', 400);
      }
      const humanServiceFqn = str(args.humanServiceFqn) || undefined;
      // Preview-first, ALWAYS: a read-only dry-run across every governed mart. When no
      // om-catalog connection is visible the preview is empty + ok → nothing to queue.
      const preview = await previewCatalogIngest(user, { humanServiceFqn });
      if (!preview.connectionName || preview.totals.syncable === 0) {
        return { decision: 'noop', summary: preview.summary, note: 'Nothing to refresh — no syncable governed mart / no om-catalog connection.' };
      }

      // Guard 6 — HOLD for human approval (Write-approval), reusing the connection_write
      // effect. The effect recomputes the whole refresh server-side and writes via the
      // least-privilege writer bot. The refresh spans domains → tenant-scoped approval.
      const approval = enqueue({
        kind: 'connection_write',
        title: `Refresh OpenMetadata catalog (${preview.connectionName})`,
        detail: preview.summary,
        agent: user.id,
        domain: user.domains[0] ?? 'platform',
        requestedBy: user.id,
        tool: 'refresh_catalog',
        approverRole: 'admin',
        scope: 'tenant',
        source: 'Connections',
        payload: { humanServiceFqn: humanServiceFqn ?? null },
        preview: {
          what: preview.summary,
          who: 'Sovereign OS writer bot (least-privilege, scoped to the sovereign_os namespace)',
          why: 'Bulk-refresh the external catalog so it reflects the live governed lakehouse (tables + lineage + DQ).',
          impact: `${preview.totals.creates} entity create/update, ${preview.totals.edges} lineage edge(s), ${preview.totals.suites} TestSuite + ${preview.totals.testCases} TestCase(s); ZERO human fields touched.`,
          diff: preview.datasets.filter((x) => x.metadata.ok || (x.dq && x.dq.ok)).map((x) => `${x.name}: ${x.metadata.ok ? x.metadata.summary : x.metadata.rejected}`).join('\n'),
        },
      });
      return {
        decision: 'requires_approval',
        approvalId: approval.id,
        summary: preview.summary,
        note: 'Held for human approval in the Governance tab (Write-approval, tenant-scoped). The refresh runs only once approved; the plan is recomputed server-side on approval.',
      };
    },
  },
];

