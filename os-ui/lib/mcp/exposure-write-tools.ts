/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool } from './server';
import { fail, str, strArr, idArg } from './discovery-common';

// --- Governed lib functions (the EXACT same the Expose/Adopt UI + /api routes call) ------
import {
  listExposureSets,
  createExposureSet,
  type ExposureTableRef,
} from '@/lib/connections/exposures';
import { recompileExposures } from '@/lib/connections/exposure-policy';
import { revokeExposureAndPropagate, updateExposureAndRecompile } from '@/lib/connections/exposure-propagation';
import { getCatalogSnapshot, refreshCatalogSnapshot } from '@/lib/connections/warehouse/catalog-snapshot';
import { getMergedClassification, runClassification, UNSORTED } from '@/lib/connections/warehouse/catalog-classification';
import { listExposedTablesForUser } from '@/lib/connections/exposed-tables';
import { adoptExposedTable, type AdoptSyncInput } from '@/lib/data/adopt-connected';
import { roleAtLeast } from '@/lib/core/session';

/**
 * MCP PARITY for the lakehouse expose/adopt journey (lakehouse-expose-experience.md Phase D
 * + lakehouse-import-exposure.md Phase 4). Each tool is a THIN adapter over the EXACT SAME
 * lib the connection-detail Expose panel + the Data-tab Adopt panel call, under the caller's
 * delegated identity — so OPA, DLS, the admin/domain_admin floors, the OPA recompile, and the
 * revoke propagation are byte-identical to the UI path (the MCP front-door invariant). There
 * is no privileged path: identity + the role floor come from the session, NEVER the body.
 *
 * The gates, restated at the tool boundary (mirrors the lib gates each calls):
 *   • Exposure CRUD + catalog refresh/classify are ADMIN (a Company-tier act);
 *   • catalog snapshot/classification READS are domain-visible (see the connection);
 *   • adopt READS are domain-scoped; ADOPT itself floors at `domain_admin` (the adoption gate).
 */

/** Coerce an array of `{schema,table}` (or `"schema.table"` strings) to ExposureTableRefs. */
function readTables(v: unknown): ExposureTableRef[] {
  if (!Array.isArray(v)) return [];
  const out: ExposureTableRef[] = [];
  for (const el of v) {
    if (typeof el === 'string') {
      const dot = el.indexOf('.');
      if (dot <= 0) continue;
      out.push({ schema: el.slice(0, dot).trim(), table: el.slice(dot + 1).trim() });
    } else if (el && typeof el === 'object') {
      const o = el as { schema?: unknown; table?: unknown };
      const schema = str(o.schema).trim();
      const table = str(o.table).trim();
      if (schema && table) out.push({ schema, table });
    }
  }
  return out;
}

const TABLES_SCHEMA = {
  type: 'array',
  description: 'Tables to expose, each `{schema, table}` (or a "schema.table" string). They must exist in this connection\'s catalog snapshot.',
  items: {
    type: 'object',
    properties: { schema: { type: 'string' }, table: { type: 'string' } },
    required: ['schema', 'table'],
  },
};

export const exposureWriteTools: McpTool[] = [
  // ─────────────────────────── Exposure CRUD (admin) ───────────────────────────
  {
    name: 'list_exposure_sets',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the exposure sets on a warehouse connection you can see — each says "these tables are readable by these domains" (name, domains, mode live|sync, tier silver|gold, table count, revoked?). An exposure is the SECURITY gate that opens a live external catalog to exactly its domains (unexposed external tables read zero rows for everyone). Before: list_connections → get_catalog_snapshot to see what CAN be exposed. After: create_exposure_set / update_exposure_set / revoke_exposure_set (admin). Governance: read-only; an unseeable connection → not_found.',
    inputSchema: idArg('connId', 'Warehouse connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_exposure_sets needs a `connId`', 400);
      const exposures = await listExposureSets(id, user);
      return { connectionId: id, exposures };
    },
  },
  {
    name: 'create_exposure_set',
    tab: 'connections',
    minRole: 'admin',
    description:
      'CREATE an exposure set (admin only) — grant the listed tables of a warehouse connection to one or more domains, live-federated or as a scheduled synced copy, at silver|gold. On success it COMPILES STRAIGHT TO OPA: each table becomes a `data.governance.tables` entry shared with those domains, so the live external catalog opens to exactly them and stays fail-closed for everyone else. This is the SAME governed path the Expose panel\'s Create button runs. Before: get_catalog_snapshot (real tables) + real domain ids. After: a domain admin runs adopt_exposed_table. Governance: admin re-gated in-lib; every table must exist in the snapshot; audit-traced. Response carries the OPA push result (honest — deferred if OPA is unreachable).',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Warehouse connection id from list_connections.' },
        name: { type: 'string', description: 'A short name for the exposure set.' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Domain ids that may read the listed tables.' },
        mode: { type: 'string', enum: ['live', 'sync'], description: "'live' federates every read (default); 'sync' lands a scheduled copy." },
        tier: { type: 'string', enum: ['silver', 'gold'], description: 'Curation tier the tables are declared at (default silver).' },
        tables: TABLES_SCHEMA,
        note: { type: 'string', description: 'Optional note stored on the set.' },
      },
      required: ['connId', 'name', 'domains', 'tables'],
      examples: [{ connId: 'conn_ab12cd', name: 'Sales → Commerce', domains: ['commerce'], mode: 'live', tier: 'gold', tables: [{ schema: 'sales', table: 'orders' }] }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('create_exposure_set needs a `connId`', 400);
      const tables = readTables(args.tables);
      const exposure = await createExposureSet(id, user, {
        name: str(args.name),
        domains: strArr(args.domains),
        mode: str(args.mode) === 'sync' ? 'sync' : str(args.mode) === 'live' ? 'live' : undefined,
        tier: str(args.tier) === 'gold' ? 'gold' : str(args.tier) === 'silver' ? 'silver' : undefined,
        tables,
        note: str(args.note) || undefined,
      });
      const policy = await recompileExposures();
      return { exposure, policy };
    },
  },
  {
    name: 'update_exposure_set',
    tab: 'connections',
    minRole: 'admin',
    description:
      'EDIT an exposure set (admin only) — change its name, domains, mode, tier, tables or note. The FQNs it mapped to BEFORE the edit are snapshotted, so any table the edit DROPS (or a domain it removes) is WITHDRAWN from OPA and the full active set is recompiled — a dropped table closes to zero rows immediately. This is the SAME `updateExposureAndRecompile` seam the Expose panel\'s Update button runs. Before: list_exposure_sets (find the id). Governance: admin re-gated in-lib; audit-traced. Response carries the OPA push result.',
    inputSchema: {
      type: 'object',
      properties: {
        exposureId: { type: 'string', description: 'Exposure set id from list_exposure_sets.' },
        name: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['live', 'sync'] },
        tier: { type: 'string', enum: ['silver', 'gold'] },
        tables: TABLES_SCHEMA,
        note: { type: 'string' },
      },
      required: ['exposureId'],
      examples: [{ exposureId: 'exp_ab12cd', domains: ['commerce', 'finance'] }],
    },
    call: async (user, args) => {
      const exposureId = str(args.exposureId).trim();
      if (!exposureId) fail('update_exposure_set needs an `exposureId`', 400);
      const input: Parameters<typeof updateExposureAndRecompile>[2] = {};
      if (args.name !== undefined) input.name = str(args.name);
      if (args.domains !== undefined) input.domains = strArr(args.domains);
      if (args.mode !== undefined) input.mode = str(args.mode) === 'sync' ? 'sync' : 'live';
      if (args.tier !== undefined) input.tier = str(args.tier) === 'gold' ? 'gold' : 'silver';
      if (args.tables !== undefined) input.tables = readTables(args.tables);
      if (args.note !== undefined) input.note = str(args.note);
      return updateExposureAndRecompile(exposureId, user, input);
    },
  },
  {
    name: 'revoke_exposure_set',
    tab: 'connections',
    minRole: 'admin',
    description:
      'REVOKE an exposure set (admin only) — withdraw its tables from OPA so live reads drop to ZERO ROWS on the next recompile (the fail-closed floor takes over). REVOCATION PROPAGATES honestly, exactly as the Expose panel\'s Revoke button does (shared `revokeExposureAndPropagate`): every dataset adopted from this exposure is frozen (`connected.status="source-revoked"`), its sync CronJob torn down, its owner notified, and a `dataset_source_revoked` trace written per dataset — never silent. A synced copy keeps its last-landed data; a live one shows the banner. Before: list_exposure_sets. Governance: admin re-gated in-lib. Response reports the OPA push + how many datasets were frozen.',
    inputSchema: idArg('exposureId', 'Exposure set id from list_exposure_sets.'),
    call: async (user, args) => {
      const exposureId = str(args.exposureId).trim();
      if (!exposureId) fail('revoke_exposure_set needs an `exposureId`', 400);
      return revokeExposureAndPropagate(exposureId, user);
    },
  },

  // ─────────────────────────── Catalog snapshot + classification ───────────────────────────
  {
    name: 'get_catalog_snapshot',
    tab: 'connections',
    minRole: 'creator',
    description:
      'READ the cached catalog snapshot of a warehouse connection you can see — the schema.table listing built from governed SHOW SCHEMAS/SHOW TABLES, with `takenAt` (freshness is always "snapshot from <takenAt>", never fabricated), `status` (live|stale|unreachable), and `prevDiff` (drift: tables added/removed since the previous snapshot). Returns `{snapshot:null}` when none has been taken — call refresh_connection_catalog first. Before: register + test the warehouse catalog. After: create_exposure_set with real tables, or classify_catalog to organize them. Governance: read-only; an unseeable connection → not_found; never invents tables.',
    inputSchema: idArg('connId', 'Warehouse connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_catalog_snapshot needs a `connId`', 400);
      const snapshot = await getCatalogSnapshot(id, user);
      return { connectionId: id, snapshot };
    },
  },
  {
    name: 'refresh_connection_catalog',
    tab: 'connections',
    minRole: 'admin',
    description:
      'REFRESH a warehouse connection\'s catalog snapshot (admin only) — re-run governed SHOW SCHEMAS/SHOW TABLES AS the connection\'s domain and cache the new listing, computing the drift diff against the previous snapshot. This is the SAME action the Expose panel\'s Refresh button runs. Before: the catalog must be registered + queryable (else `status:"unreachable"` with the real reason — never a fabricated listing). After: get_catalog_snapshot / classify_catalog / create_exposure_set. Governance: admin re-gated (a catalog re-probe is a Company-tier act).',
    inputSchema: idArg('connId', 'Warehouse connection id you can see.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('refresh_connection_catalog needs a `connId`', 400);
      if (!roleAtLeast(user.role, 'admin')) fail('Refreshing a connection catalog requires an Administrator', 403);
      const snapshot = await refreshCatalogSnapshot(id, user);
      return { connectionId: id, snapshot };
    },
  },
  {
    name: 'get_catalog_classification',
    tab: 'connections',
    minRole: 'creator',
    description:
      'READ the AI folder organization of a warehouse connection\'s catalog you can see — the taxonomy (folders), the merged per-table placement (a human move ?? the AI suggestion ?? Unsorted), the category counts, the last-run detail, and (when unseeded) the smart-default seed the chooser would pre-select. Honest: a table with no AI entry and no human move resolves to Unsorted; every placement is "suggested, not verified". Before: get_catalog_snapshot. After: classify_catalog (admin) to (re)run, or create_exposure_set by folder. Governance: read-only; an unseeable connection → not_found.',
    inputSchema: idArg('connId', 'Warehouse connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_catalog_classification needs a `connId`', 400);
      const classification = await getMergedClassification(id, user);
      return { connectionId: id, ...classification, counts: categoryCounts(classification.placements) };
    },
  },
  {
    name: 'classify_catalog',
    tab: 'connections',
    minRole: 'admin',
    description:
      'ORGANIZE a warehouse catalog with AI (admin only) — run the names-first classifier (capped column-enriched second pass) to place every snapshot table into the CURRENT taxonomy. It NEVER invents folders; a table it cannot place (or below the confidence floor) lands in Unsorted with a plain reason; human moves (overrides) are never touched. `mode:"run"` reclassifies all; `mode:"run-new"` only tables with no entry yet. This is the SAME action the Organize stage\'s "Organize with AI" button runs — a taxonomy seed must already be chosen (else an honest error). Returns the honest run tally + `lastRunDetail` ("132 classified, 12 unsorted, 3 batches escalated, …") + the resulting category counts — never a fabricated tally. Governance: admin re-gated in-lib; `catalog_classified` trace.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Warehouse connection id you can see.' },
        mode: { type: 'string', enum: ['run', 'run-new'], description: "'run' reclassifies all snapshot tables; 'run-new' only tables with no AI entry yet (default run)." },
      },
      required: ['connId'],
      examples: [{ connId: 'conn_ab12cd' }, { connId: 'conn_ab12cd', mode: 'run-new' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('classify_catalog needs a `connId`', 400);
      const mode = str(args.mode) === 'run-new' ? 'run-new' : 'run';
      const { tally } = await runClassification(id, user, mode);
      const classification = await getMergedClassification(id, user);
      return {
        connectionId: id,
        mode,
        tally,
        lastRunDetail: classification.lastRunDetail ?? null,
        counts: categoryCounts(classification.placements),
      };
    },
  },

  // ─────────────────────────── Adopt (domain-scoped) ───────────────────────────
  {
    name: 'list_exposed_tables',
    tab: 'data',
    minRole: 'creator',
    description:
      'List the warehouse tables exposed TO YOUR DOMAIN(S) that you may adopt as governed datasets — grouped connection → exposure set (name, mode live|sync, tier, the granted tables). This is the domain-intersection view of the exposure registry (only non-revoked exposures sharing one of your domains appear). Path: DISCOVERY for the Adopt flow (replaces "pull from a product"). Before: whoami (your domains). After: ⛔ domain_admin adopt_exposed_table. Governance: read-only, scoped to your domains — you never see an exposure not shared with you.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => {
      const connections = await listExposedTablesForUser(user);
      return { connections };
    },
  },
  {
    name: 'adopt_exposed_table',
    tab: 'data',
    minRole: 'domain_admin',
    description:
      'ADOPT one exposed table as a governed Domain-tier dataset (⛔ domain_admin — the adoption gate). The exposure is RE-RESOLVED server-side (active, shared with one of your domains) so governance is never trusted from the args; the `schema.table` must be one the exposure actually lists; a short `description` is REQUIRED (feeds the documentation gate). The dataset is born `origin:"connected"` at the exposure\'s tier: a LIVE exposure federates every read through the external FQN; a SYNC exposure attaches a validated sync config (connection + source PINNED to the exposure) and provisions the per-dataset CronJob. This is the SAME `/api/data/adopt` path the Adopt panel runs. Before: list_exposed_tables. After: profile_dataset / query_data / define_metric (on a synced copy). Governance: domain_admin re-gated + external-connectors flag; `dataset_adopted` trace.',
    inputSchema: {
      type: 'object',
      properties: {
        exposureId: { type: 'string', description: 'Exposure set id from list_exposed_tables.' },
        schema: { type: 'string', description: 'Source schema (must be one the exposure lists).' },
        table: { type: 'string', description: 'Source table (must be one the exposure lists).' },
        name: { type: 'string', description: 'Dataset name (defaults to the table name).' },
        description: { type: 'string', description: 'REQUIRED short description of the table and its purpose.' },
        sync: {
          type: 'object',
          description: 'SYNC-mode config (ignored for a live exposure). Omit to use the exposure\'s declared defaults (full refresh, its schedule).',
          properties: {
            mode: { type: 'string', enum: ['full-refresh', 'append', 'merge'] },
            cursor: { type: 'object', properties: { kind: { type: 'string', enum: ['timestamp', 'number'] }, column: { type: 'string' } } },
            mergeKeys: { type: 'array', items: { type: 'string' } },
            schedule: { type: 'object', properties: { cron: { type: 'string' } } },
            enabled: { type: 'boolean' },
          },
        },
      },
      required: ['exposureId', 'schema', 'table', 'description'],
      examples: [{ exposureId: 'exp_ab12cd', schema: 'sales', table: 'orders', description: 'Order lines for the Commerce team.' }],
    },
    call: async (user, args) => {
      const exposureId = str(args.exposureId).trim();
      const schema = str(args.schema).trim();
      const table = str(args.table).trim();
      const description = str(args.description).trim();
      if (!exposureId || !schema || !table) fail('adopt_exposed_table needs an `exposureId`, `schema` and `table`', 400);
      if (!description) fail('A short `description` is required to adopt a connected table', 400);
      // Same shared seam the /api/data/adopt route runs — LIVE + SYNC (validated, connection +
      // source pinned to the exposure, CronJob provisioned), governance re-resolved server-side.
      const sync = (args.sync && typeof args.sync === 'object' ? (args.sync as AdoptSyncInput) : undefined);
      const { dataset, cron } = await adoptExposedTable(user, { exposureId, schema, table, name: str(args.name), description, sync });
      return { dataset, ...(cron ? { cron } : {}) };
    },
  },
];

/** Category id → count over a merged placements map (the honest "N in each folder" tally). */
function categoryCounts(placements: Record<string, { category: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Object.values(placements)) out[p.category] = (out[p.category] ?? 0) + 1;
  if (!(UNSORTED in out) && Object.keys(placements).length > 0) out[UNSORTED] = out[UNSORTED] ?? 0;
  return out;
}
