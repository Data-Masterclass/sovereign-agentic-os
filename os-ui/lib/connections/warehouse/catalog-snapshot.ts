/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { osMirror } from '@/lib/infra/os-mirror';
import { queryRun } from '@/lib/infra/governed';
import { discoverWarehouse, getConnectionForUser } from '@/lib/connections/store';
import { providerFor } from '@/lib/connections/warehouse/registry';
import { toWarehouseSource } from '@/lib/connections/warehouse/connection';
import { operationalEntry } from '@/lib/connections/operational-registry';

/**
 * Per-connection CATALOG SNAPSHOT — the cached, honest listing the Expose UI browses
 * (lakehouse-import-exposure.md). Built by looping the EXISTING governed
 * `discoverWarehouse` (`SHOW SCHEMAS` + per-schema `SHOW TABLES`) AS the connection's
 * domain, so Trino→OPA governs every read — this is NOT a back door around the query
 * path. Columns are deliberately NOT part of the snapshot (~1k tables would be
 * expensive to DESCRIBE eagerly); `describeTable` serves per-table column expansion
 * lazily on demand.
 *
 * Freshness is ALWAYS surfaced as "snapshot from <takenAt>", never fabricated. When the
 * catalog is unreachable (unregistered / offline) the snapshot honestly records
 * `status:'unreachable'` and lists nothing rather than inventing a listing. `prevDiff`
 * is the diff of two consecutive snapshots (tables added/removed) so drift is visible.
 *
 * Persisted via the SAME registry-mirror pattern the connections store uses
 * (`os-catalog-snapshots`): an authoritative in-process Map + a best-effort OpenSearch
 * write-through, so a snapshot survives a pod roll.
 */

export type CatalogTableRef = { schema: string; table: string };

export type CatalogDiff = {
  added: CatalogTableRef[];
  removed: CatalogTableRef[];
};

export type CatalogSnapshot = {
  connectionId: string;
  catalog: string;
  /** 'live' — freshly discovered; 'stale' — served from cache, discovery didn't run;
   *  'unreachable' — the catalog could not be queried (unregistered/offline). */
  status: 'live' | 'stale' | 'unreachable';
  takenAt: string;
  /** Every schema.table pair visible through the governed path, sorted. */
  tables: CatalogTableRef[];
  /** Diff against the immediately-previous snapshot (empty on the first one). */
  prevDiff: CatalogDiff;
  detail: string;
};

function now(): string {
  return new Date().toISOString();
}

const mirror = osMirror({ index: 'os-catalog-snapshots' });

type SnapCacheState = { cache: Map<string, CatalogSnapshot> | null };
const SNAP_STATE_KEY = Symbol.for('soa.catalog-snapshots.cache');
function snapState(): SnapCacheState {
  const g = globalThis as unknown as Record<symbol, SnapCacheState | undefined>;
  if (!g[SNAP_STATE_KEY]) g[SNAP_STATE_KEY] = { cache: null };
  return g[SNAP_STATE_KEY]!;
}

async function getCache(): Promise<Map<string, CatalogSnapshot>> {
  const s = snapState();
  if (s.cache) return s.cache;
  const map = new Map<string, CatalogSnapshot>();
  const docs = await mirror.hydrate(500);
  for (const d of (docs ?? []) as CatalogSnapshot[]) map.set(d.connectionId, d);
  s.cache = map;
  return map;
}

function writeThrough(snap: CatalogSnapshot): void {
  mirror.writeThrough(snap.connectionId, snap);
}

function keyOf(t: CatalogTableRef): string {
  return `${t.schema}.${t.table}`;
}

function diff(prev: CatalogTableRef[], next: CatalogTableRef[]): CatalogDiff {
  const prevKeys = new Set(prev.map(keyOf));
  const nextKeys = new Set(next.map(keyOf));
  return {
    added: next.filter((t) => !prevKeys.has(keyOf(t))),
    removed: prev.filter((t) => !nextKeys.has(keyOf(t))),
  };
}

/**
 * The seam under {@link refreshCatalogSnapshot}: how tables are discovered. Defaults to
 * the governed `discoverWarehouse`; INJECTABLE so tests drive the loop without a
 * cluster. Returns null for a schema whose table list could not be read.
 */
export type DiscoverFn = (
  connId: string,
  user: CurrentUser,
  opts: { schema?: string },
) => Promise<{ ok: boolean; schemas: string[]; tables: string[] }>;

/** How a schema's schemas/tables are discovered, bound to one connection. Both the
 *  user-scoped and service refreshes provide one; the build loop is shared. */
type BoundDiscover = (opts: { schema?: string }) => Promise<{ ok: boolean; schemas: string[]; tables: string[] }>;

/** The shared snapshot-build core: `SHOW SCHEMAS`, then `SHOW TABLES` per schema, diffed
 *  against the previous snapshot, persisted, returned with an honest status. */
async function buildSnapshot(connId: string, catalog: string, discover: BoundDiscover): Promise<CatalogSnapshot> {
  const map = await getCache();
  const prev = map.get(connId);

  // First hop: schemas. An unreachable/unregistered catalog → honest 'unreachable'
  // snapshot (last-known tables are NOT resurrected — a fresh unreachable listing is
  // empty, and the takenAt says when we tried).
  const top = await discover({});
  if (!top.ok) {
    const snap: CatalogSnapshot = {
      connectionId: connId,
      catalog,
      status: 'unreachable',
      takenAt: now(),
      tables: [],
      prevDiff: diff(prev?.tables ?? [], []),
      detail: `Catalog '${catalog}' is not queryable — register it, then refresh.`,
    };
    map.set(connId, snap);
    writeThrough(snap);
    return snap;
  }

  const tables: CatalogTableRef[] = [];
  for (const schema of top.schemas) {
    const res = await discover({ schema });
    if (!res.ok) continue; // a schema we couldn't list contributes nothing, honestly
    for (const table of res.tables) tables.push({ schema, table });
  }
  tables.sort((a, b) => (a.schema === b.schema ? a.table.localeCompare(b.table) : a.schema.localeCompare(b.schema)));

  const snap: CatalogSnapshot = {
    connectionId: connId,
    catalog,
    status: 'live',
    takenAt: now(),
    tables,
    prevDiff: diff(prev?.tables ?? [], tables),
    detail: `Snapshot of ${tables.length} table(s) across ${top.schemas.length} schema(s) in '${catalog}'.`,
  };
  map.set(connId, snap);
  writeThrough(snap);
  return snap;
}

/**
 * BUILD (refresh) the catalog snapshot for a connection: `SHOW SCHEMAS`, then
 * `SHOW TABLES` per schema, all through the governed path AS the caller. Persists +
 * returns the new snapshot. A caller who can see the connection may refresh (read-only).
 */
export async function refreshCatalogSnapshot(
  connId: string,
  user: CurrentUser,
  deps: { discover?: DiscoverFn } = {},
): Promise<CatalogSnapshot> {
  const c = await getConnectionForUser(connId, user); // 404s if not visible

  // OPERATIONAL sources (Salesforce / Kajabi / …) discover their ENTITIES through the
  // operational registry instead of `discoverWarehouse` (Trino cannot reach them). The
  // entity catalog rides the SAME snapshot machinery: the registry returns the flat
  // entity list under ONE pseudo-schema ('salesforce'/'kajabi'), which we adapt to the
  // build loop's `{schemas}` then `{schema→tables}` contract. Snapshot honesty
  // (status/takenAt/prevDiff) is identical to the warehouse path.
  const op = operationalEntry(c.template);
  if (op) {
    const catalog = op.platform; // the pseudo-catalog identity (no Trino catalog exists)
    // One real discovery call; cached so the two build-loop hops don't double-fetch.
    let cached: Awaited<ReturnType<typeof op.discover>> | null = null;
    const discoverOnce = async () => (cached ??= await op.discover(connId, user));
    const boundOp: BoundDiscover = async (opts) => {
      const res = await discoverOnce();
      if (!res.ok) return { ok: false, schemas: [], tables: [] };
      return opts.schema
        ? { ok: true, schemas: [], tables: res.tables }
        : { ok: true, schemas: res.schemas, tables: [] };
    };
    return buildSnapshot(connId, catalog, boundOp);
  }

  const discover = deps.discover ?? discoverWarehouse;
  const catalog = c.warehouse?.catalog ?? c.endpoint;
  return buildSnapshot(connId, catalog, (opts) => discover(connId, user, opts));
}

/**
 * SERVICE refresh (the `connections.catalogRefresh` sweep) — re-snapshot a warehouse
 * connection WITHOUT a signed-in user, running `SHOW SCHEMAS`/`SHOW TABLES` through the
 * governed query path AS the connection's OWN domain (the same principal
 * `discoverWarehouse` forwards). The connection is already trusted (resolved server-side
 * by {@link listWarehouseConnections}); there is no per-user visibility to enforce.
 */
export async function refreshCatalogSnapshotService(
  c: Connection,
  deps: { query?: typeof queryRun } = {},
): Promise<CatalogSnapshot> {
  if (c.template !== 'warehouse' || !c.warehouse) {
    throw Object.assign(new Error('Not a warehouse connection'), { status: 400 });
  }
  const provider = providerFor(c.warehouse.platform);
  const source = toWarehouseSource({ platform: c.warehouse.platform, catalog: c.warehouse.catalog, config: c.warehouse.config });
  const catalog = c.warehouse.catalog;
  const query = deps.query ?? queryRun;
  const discover: BoundDiscover = async (opts) => {
    if (!provider.discoverTables) return { ok: false, schemas: [], tables: [] };
    try {
      if (!opts.schema) {
        const q = provider.testProbe.kind === 'sql' ? provider.testProbe.query(source) : `SHOW SCHEMAS FROM ${catalog}`;
        const res = await query(q, c.domain, c.domain);
        return { ok: true, schemas: res.rows.map((r) => String(r[0])).filter(Boolean), tables: [] };
      }
      const res = await query(provider.discoverTables(source, opts.schema), c.domain, c.domain);
      return { ok: true, schemas: [], tables: res.rows.map((r) => String(r[0])).filter(Boolean) };
    } catch {
      return { ok: false, schemas: [], tables: [] };
    }
  };
  return buildSnapshot(c.id, catalog, discover);
}

/**
 * GET the cached snapshot (no discovery). Returns null when none has ever been taken —
 * the UI then offers a Refresh. A returned snapshot keeps its own `status`/`takenAt` so
 * the UI shows "snapshot from <takenAt>" honestly (a cached live snapshot is served as
 * 'stale' so the caller knows discovery didn't just run).
 */
export async function getCatalogSnapshot(connId: string, user: CurrentUser): Promise<CatalogSnapshot | null> {
  await getConnectionForUser(connId, user); // 404s if not visible
  const map = await getCache();
  const snap = map.get(connId);
  if (!snap) return null;
  // A cached live snapshot is honestly 'stale' when merely read back (not re-discovered).
  return snap.status === 'live' ? { ...snap, status: 'stale' } : snap;
}

/** One table's columns, from a governed `DESCRIBE`. Shaped for a lazy per-table expand.
 *  `comment` is Trino's per-column doc string (empty when the metastore carries none);
 *  the Phase-B classifier reads it, so the describe path returns it additively. */
export type TableColumn = { name: string; type: string; comment?: string; label?: string };

/**
 * LAZY per-table column expansion — a governed `DESCRIBE <catalog>.<schema>.<table>` AS
 * the connection's domain. Deliberately NOT part of the snapshot; the Expose UI calls it
 * only when a table is expanded. Honest: an unreachable catalog throws (the route folds
 * it into a 4xx/5xx), never a fabricated column list.
 */
export async function describeTable(
  connId: string,
  user: CurrentUser,
  input: { schema: string; table: string },
  deps: { query?: typeof queryRun } = {},
): Promise<TableColumn[]> {
  const c = await getConnectionForUser(connId, user);
  if (c.template !== 'warehouse' || !c.warehouse) {
    throw Object.assign(new Error('Not a warehouse connection'), { status: 400 });
  }
  // Validate identifiers through the provider's own table-listing builder rules by
  // reusing its source shape; DESCRIBE takes a plain FQN. Reject anything that isn't a
  // bare identifier so a schema/table can't smuggle SQL.
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!ident.test(input.schema) || !ident.test(input.table)) {
    throw Object.assign(new Error('Invalid schema/table identifier'), { status: 400 });
  }
  // Touch the provider/source so a platform with no metastore fails the same honest way
  // discovery does (keeps DESCRIBE consistent with SHOW TABLES).
  const provider = providerFor(c.warehouse.platform);
  toWarehouseSource({ platform: c.warehouse.platform, catalog: c.warehouse.catalog, config: c.warehouse.config });
  if (!provider.discoverTables) {
    throw Object.assign(new Error(`${provider.label} exposes no metastore — columns are not discoverable`), { status: 400 });
  }
  const fqn = `${c.warehouse.catalog}.${input.schema}.${input.table}`;
  const query = deps.query ?? queryRun;
  const res = await query(`DESCRIBE ${fqn}`, c.domain, c.domain);
  // Trino DESCRIBE returns Column, Type, Extra, Comment. Keep name+type and carry the
  // Comment (4th column) through additively — the Phase-B classifier reads it; older
  // metastores that omit it just yield an absent comment (never fabricated).
  return res.rows
    .map((r) => {
      const comment = r[3] == null ? '' : String(r[3]).trim();
      return { name: String(r[0]), type: String(r[1] ?? ''), ...(comment ? { comment } : {}) };
    })
    .filter((x) => x.name);
}

/**
 * DISPATCH describe per connection template (operational-system-connections.md, Phase 1).
 * A warehouse connection describes through the governed Trino `DESCRIBE`
 * ({@link describeTable}); an operational connection describes its ENTITY's fields through
 * the connector's own API (Salesforce field describe → {name, type, label}). The route +
 * CatalogBrowser consume the ONE `TableColumn[]` shape: the business `label` rides the
 * `comment` slot (rendered as the human name next to the API name), plus an additive
 * `label` field for consumers that want it explicitly. `input.schema` is the pseudo-schema
 * ('salesforce'); `input.table` is the entity (SObject). Honest: an unreachable source
 * throws (folded to 4xx/5xx), never a fabricated field list.
 */
export async function describeEntity(
  connId: string,
  user: CurrentUser,
  input: { schema: string; table: string },
): Promise<TableColumn[]> {
  const c = await getConnectionForUser(connId, user);
  const op = operationalEntry(c.template);
  if (!op) return describeTable(connId, user, input); // warehouse (or honest 400 within)
  if (op.platform === 'salesforce') {
    const { describeSalesforceObject } = await import('@/lib/connections/salesforce');
    const fields = await describeSalesforceObject(connId, user, input.table);
    return fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.label && f.label !== f.name ? { comment: f.label } : {}),
      label: f.label,
    }));
  }
  if (op.platform === 'odata') {
    // OData describes an entity set's scalar properties from $metadata (name/type/label —
    // sap:label where present, never invented).
    const { describeODataEntity } = await import('@/lib/connections/odata/client');
    const fields = await describeODataEntity(connId, user, input.table);
    return fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.label && f.label !== f.name ? { comment: f.label } : {}),
      label: f.label,
    }));
  }
  if (op.platform === 'workday') {
    // Workday RaaS has no describe — fields are INFERRED from a sampled first page and
    // labeled "inferred from a sample" (honest, never claimed as authoritative metadata).
    const { describeWorkdayReport } = await import('@/lib/connections/workday-raas');
    const fields = await describeWorkdayReport(connId, user, input.table);
    return fields.map((f) => ({ name: f.name, type: f.type, comment: f.label, label: f.label }));
  }
  // Other operational templates (Kajabi) have no field-describe endpoint — honest empty
  // (the browser shows "No columns reported"), never fabricated.
  return [];
}

/**
 * A REAL, cheap row count for ONE operational entity, on demand (Phase 1). Surfaced ONLY
 * where cheaply real: Salesforce → `SELECT COUNT()`. A warehouse or count-less operational
 * template returns `null` (absent > estimated — the design forbids fabricated counts). An
 * unreachable source THROWS (never a zero or a guess). Re-resolves FOR THE CALLER (DLS).
 */
export async function countEntity(
  connId: string,
  user: CurrentUser,
  input: { table: string },
): Promise<number | null> {
  const c = await getConnectionForUser(connId, user);
  const op = operationalEntry(c.template);
  if (op?.platform === 'salesforce') {
    const { countSalesforceObject } = await import('@/lib/connections/salesforce');
    return countSalesforceObject(connId, user, input.table);
  }
  if (op?.platform === 'odata') {
    // OData $count / $inlinecount is a cheap real count — surfaced when the service inlines
    // it; null when it omits it (absent > fabricated).
    const { countODataEntity } = await import('@/lib/connections/odata/client');
    return countODataEntity(connId, user, input.table);
  }
  // Workday RaaS + Kajabi counts are not cheaply real → absent, honestly (never estimated).
  return null;
}

/** Test seam — forget the in-process cache (mirrors the store's `__resetConnections`). */
export function __resetCatalogSnapshots(): void {
  snapState().cache = null;
  mirror.__reset();
}
