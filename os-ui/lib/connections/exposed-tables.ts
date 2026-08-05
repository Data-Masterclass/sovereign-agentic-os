/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { allActiveExposures, type ExposureSet } from '@/lib/connections/exposures';
import { getConnectionById } from '@/lib/connections/store';
import { operationalPlatformFor, type OperationalPlatform } from '@/lib/connections/operational-platform';
import { cursorSupportForPlatform } from '@/lib/connections/operational-cursor';
import { config } from '@/lib/core/config';
import type { Connection } from '@/lib/connections/schema';

/**
 * EXPOSED-TABLES resolution (lakehouse-import-exposure.md, Phase 2 — the Adopt read side).
 * A domain admin adopting "from a connection" browses ONLY the tables an ExposureSet
 * grants to a domain they belong to. This is the DOMAIN-INTERSECTION view of the same
 * exposure registry the compiler reads: for every NON-revoked exposure whose `domains`
 * intersect the caller's `domains`, surface its connection + catalog + tables, grouped
 * connection → exposure set.
 *
 * BOTH modes adoptable (Phase 3): a LIVE exposure federates every read; a SYNC exposure
 * lands a scheduled governed copy into the domain schema. Both are adoptable — the adopt
 * dialog shows sync setup for sync-mode exposures, prefilled from `syncDefaults`.
 *
 * Not a query path — it reads the exposure + connection registries server-side. The adopt
 * ACTION re-resolves the exposure by id and re-checks the intersection before creating a
 * dataset (defence in depth), so this is purely the browse projection.
 */

export type ExposedTable = {
  schema: string;
  table: string;
  /** Operational sources only: the honest cursor support for this entity (from the
   *  registry) — the adopt dialog locks cursor options to it. Absent for warehouse tables. */
  cursor?: { incremental: boolean; column: string | null; chip: string; note: string };
};

/** Sync scheduling defaults an exposure carries (mode='sync') — the adopt dialog prefills
 *  from these in the SyncPanel vocabulary. Absent members fall back to the panel defaults. */
export type ExposedSyncDefaults = { schedule?: string; fullRefresh?: boolean };

export type ExposedExposure = {
  exposureId: string;
  name: string;
  mode: 'live' | 'sync';
  tier: 'silver' | 'gold';
  /** Both live and sync exposures are adoptable (Phase 3). Kept on the shape so a future
   *  deferral (a not-yet-executable cursor kind, say) can re-flag one honestly. */
  adoptable: boolean;
  /** The honest reason an exposure isn't adoptable (only set when adoptable=false). */
  deferredReason?: string;
  /** The domains (intersecting the caller) this exposure grants to. */
  domains: string[];
  tables: ExposedTable[];
  /** Sync scheduling defaults (present only on a sync-mode exposure). */
  syncDefaults?: ExposedSyncDefaults;
  /** Per-entity agent-action grant (Phase 3, flag-gated). Present only when the exposure
   *  carries actions; the domain admin adopts these into their domain to arm agents. */
  actions?: Record<string, { read?: boolean; search?: boolean; create?: boolean; update?: boolean }>;
  /** True once an admin approved this exposure's write actions (create/update). */
  writeApproved?: boolean;
  note?: string;
};

export type ExposedConnection = {
  connectionId: string;
  connectionName: string;
  /** The warehouse Trino catalog, or NULL for an operational source (no catalog exists;
   *  the sync target is the domain schema, not a federated FQN). */
  catalog: string | null;
  /** The warehouse platform, or the operational platform ('salesforce'/'kajabi'). */
  platform: string;
  /** True for an operational (api-batch) source — the adopt dialog then locks mode to Sync
   *  and reads per-entity cursor honesty from the registry (never live). */
  operational?: boolean;
  exposures: ExposedExposure[];
};

/** True when two domain lists share at least one member. */
function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((d) => set.has(d));
}

/** Project ONE exposure to the caller-domain-scoped adopt view (or null when it doesn't
 *  intersect / its connection is gone). Resolved against the LIVE connection so catalog is
 *  authoritative — the FQN a live adoption federates to is `<catalog>.<schema>.<table>`. */
function toExposed(e: ExposureSet, callerDomains: string[], c: Connection): ExposedExposure {
  const granted = e.domains.filter((d) => callerDomains.includes(d));
  const platform = operationalPlatformFor(c.template);
  const tables: ExposedTable[] = e.tables.map((t) => {
    if (!platform) return { schema: t.schema, table: t.table };
    const cur = cursorSupportForPlatform(platform, t.table);
    return {
      schema: t.schema,
      table: t.table,
      cursor: { incremental: cur.incremental, column: cur.cursorColumn, chip: cur.chip, note: cur.note },
    };
  });
  // deferredReason carries real cursor honesty for an operational exposure whose every
  // entity is full-refresh-only (the honest "why" — never guessed). The exposure stays
  // ADOPTABLE (sync via full refresh always works); this is a heads-up, not a block.
  const fullRefreshOnly = platform && tables.length > 0 && tables.every((t) => t.cursor && !t.cursor.incremental);
  return {
    exposureId: e.id,
    name: e.name,
    mode: e.mode,
    tier: e.tier,
    // Both modes are adoptable in Phase 3.
    adoptable: true,
    ...(fullRefreshOnly ? { deferredReason: `Full refresh only — ${tables[0].cursor!.note}` } : {}),
    domains: granted,
    tables,
    ...(e.mode === 'sync' && e.syncDefaults
      ? { syncDefaults: { ...(e.syncDefaults.schedule ? { schedule: e.syncDefaults.schedule } : {}), ...(e.syncDefaults.fullRefresh !== undefined ? { fullRefresh: e.syncDefaults.fullRefresh } : {}) } }
      : {}),
    // Agent actions (Phase 3, flag-gated). Surfaced so a domain admin can adopt them.
    ...(config.operationalActionsEnabled && e.actions ? { actions: e.actions, writeApproved: e.writeApproved ?? false } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

/**
 * The connection→exposure→table tree the caller (a domain admin) may adopt from: every
 * non-revoked exposure that grants at least one of the caller's domains, grouped by its
 * warehouse connection. A connection with no intersecting exposure never appears. Both
 * live and sync exposures are adoptable (Phase 3).
 */
export async function listExposedTablesForUser(user: CurrentUser): Promise<ExposedConnection[]> {
  const exposures = await allActiveExposures();
  const byConn = new Map<string, ExposureSet[]>();
  for (const e of exposures) {
    if (!intersects(e.domains, user.domains)) continue;
    const list = byConn.get(e.connectionId) ?? [];
    list.push(e);
    byConn.set(e.connectionId, list);
  }

  const out: ExposedConnection[] = [];
  for (const [connId, sets] of byConn.entries()) {
    const c = await getConnectionById(connId);
    if (!c || c.archived) continue;
    const opPlatform = operationalPlatformFor(c.template);
    // Warehouse OR operational (Salesforce/Kajabi). Any other template can't back an
    // adoptable exposure.
    if (c.template === 'warehouse' && c.warehouse) {
      out.push({
        connectionId: connId,
        connectionName: c.name,
        catalog: c.warehouse.catalog,
        platform: c.warehouse.platform,
        exposures: sets.map((e) => toExposed(e, user.domains, c)).sort((a, b) => a.name.localeCompare(b.name)),
      });
    } else if (opPlatform) {
      out.push({
        connectionId: connId,
        connectionName: c.name,
        catalog: null, // operational: no Trino catalog; sync lands in the domain schema
        platform: opPlatform,
        operational: true,
        exposures: sets.map((e) => toExposed(e, user.domains, c)).sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }
  out.sort((a, b) => a.connectionName.localeCompare(b.connectionName));
  return out;
}

/**
 * Resolve ONE exposure for adoption AS the caller: it must be active (live OR sync) and
 * grant a domain the caller belongs to. Returns the connection + exposure + the pinned
 * domain the dataset will live in (the first intersecting domain), or an error reason. The
 * adopt action calls this so the create path never trusts the request body for governance.
 */
export async function resolveAdoptableExposure(
  exposureId: string,
  user: CurrentUser,
): Promise<
  | {
      ok: true;
      exposure: ExposureSet;
      /** Warehouse: the Trino catalog. Operational: the platform PSEUDO-catalog
       *  ('salesforce'/'kajabi') — the stable source identity the adopted dataset records
       *  (consistent with the snapshot's catalog + the api-batch sync's source schema); the
       *  sync FQN seam lands in the DOMAIN schema and never dereferences it. */
      catalog: string;
      connectionName: string;
      domain: string;
      /** True for an operational source — the adopt path forces sync + registry cursor lock. */
      operational: boolean;
      /** The operational platform, when operational. */
      platform?: OperationalPlatform;
    }
  | { ok: false; status: number; reason: string }
> {
  const exposures = await allActiveExposures();
  const e = exposures.find((x) => x.id === exposureId);
  if (!e) return { ok: false, status: 404, reason: 'That exposure is no longer available.' };
  if (!intersects(e.domains, user.domains)) {
    return { ok: false, status: 403, reason: 'This exposure is not shared with any of your domains.' };
  }
  const c = await getConnectionById(e.connectionId);
  if (!c || c.archived) {
    return { ok: false, status: 404, reason: 'The source connection is no longer available.' };
  }
  const domain = e.domains.find((d) => user.domains.includes(d)) ?? user.domains[0];
  const opPlatform = operationalPlatformFor(c.template);
  if (c.template === 'warehouse' && c.warehouse) {
    return { ok: true, exposure: e, catalog: c.warehouse.catalog, connectionName: c.name, domain, operational: false };
  }
  if (opPlatform) {
    // The pseudo-catalog IS the platform name — byte-consistent with the snapshot
    // (`catalog: op.platform`) and the api-batch sync source; the FQN seam's sync branch
    // ignores it (lands in `iceberg.<domainSchema>.<tier>_<slug>`).
    return { ok: true, exposure: e, catalog: opPlatform, connectionName: c.name, domain, operational: true, platform: opPlatform };
  }
  return { ok: false, status: 404, reason: 'The source connection is no longer available.' };
}
