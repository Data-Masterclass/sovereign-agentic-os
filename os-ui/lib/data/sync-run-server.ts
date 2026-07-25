/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { executeRun, queryRun, type ExecuteIdentity } from '../infra/governed.ts';
import type { Dataset, DatasetSyncMode, Layer } from './dataset-schema.ts';
import { buildVersion, datasetForScheduler } from './store.ts';
import { personalSchema, physicalSlug } from './store-fqn.ts';
import { parseDescribe } from './profile.ts';
import {
  appendSql,
  deleteBatchSql,
  expireSnapshotsSql,
  fullRefreshSql,
  highWatermarkProbeSql,
  mergeSql,
  optimizeSql,
  type SyncCursor,
  type SyncSource,
  type SyncTarget,
} from './sync-sql.ts';
import {
  currentWatermark,
  ensureSyncRunsHydrated,
  isQuarantined,
  lastMaintenanceAt,
  recordSyncRun,
  syncRunsMirror,
  type SyncRunRecord,
} from './sync-runs.ts';

/**
 * The GOVERNED sync executor — runs ONE scheduled/manual sync of a dataset through
 * the SAME write path a one-time import uses (`executeRun` → query-tool → Trino, AS
 * the resolved OWNER, never a service principal — the agents scheduled-run contract).
 *
 * Honesty + safety contract:
 *   • CURSOR DISCIPLINE — the high watermark is probed BEFORE the write, and the
 *     cursor advances ONLY after the Iceberg write succeeded (an error run keeps the
 *     old watermark, so the next run re-covers the slice).
 *   • RETRY IDEMPOTENCY — append slices land under a deterministic `_batch_id`; the
 *     batch is deleted before (re-)appending, so a retried slice never lands twice.
 *   • SKIP-NOT-QUEUE — a held lease records an honest 'skipped' row and returns.
 *   • QUARANTINE — ≥10 trailing consecutive errors auto-pauses scheduled runs (derived
 *     in sync-runs.ts; a successful manual "Sync now" clears it).
 *   • MAINTENANCE — after a successful run, if maintenance is >24h old, run Iceberg
 *     `optimize` + `expire_snapshots` (best-effort — never fails the sync).
 */

export type SyncTrigger = 'schedule' | 'manual' | 'reset';

export type SyncOutcome =
  | { ok: true; run: SyncRunRecord; skipped?: false }
  | { ok: true; skipped: true; reason: string; run?: SyncRunRecord }
  | { ok: false; status: number; error: string };

/** Lease TTL. Must EXCEED any executor runtime (statement timeouts are 15s each) —
 *  a handler outliving its lease is how duplicate concurrent runs happen. */
export const SYNC_LEASE_TTL_MS = 60 * 60 * 1000;

/** Run table maintenance when the last one is older than this. */
export const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------- lease ----
/**
 * Best-effort distributed lease over the sync-runs mirror. A FREE lease is the
 * presence of the token doc; `claim()` (an atomic single-use delete) takes it, and
 * release writes it back. A crashed holder is detected via the held-marker's age
 * (stale after {@link SYNC_LEASE_TTL_MS}) and reclaimed. Defense in depth — the
 * primary serialization is the CronJob's `concurrencyPolicy: Forbid`; when the
 * mirror is unreachable (pure in-memory dev) the run proceeds rather than deadlock.
 */
export type SyncLease = {
  acquire: (datasetId: string, nowIso: string) => Promise<'acquired' | 'held'>;
  release: (datasetId: string, nowIso: string) => void;
};

export function mirrorLease(mirror = syncRunsMirror, ttlMs = SYNC_LEASE_TTL_MS): SyncLease {
  const tokenId = (id: string) => `sync-lease:${id}`;
  const heldId = (id: string) => `sync-lease-held:${id}`;
  return {
    async acquire(datasetId, nowIso) {
      const won = await mirror.claim(tokenId(datasetId));
      if (won === 'won' || won === 'unreachable') {
        if (won === 'won') mirror.writeThrough(heldId(datasetId), { heldAt: nowIso });
        return 'acquired';
      }
      // 'lost': either held, stale, or never seeded (first ever run).
      const marker = (await mirror.getDoc(heldId(datasetId))) as { heldAt?: string } | null;
      const heldAt = marker?.heldAt ? Date.parse(marker.heldAt) : NaN;
      if (Number.isFinite(heldAt) && Date.parse(nowIso) - heldAt < ttlMs) return 'held';
      // Stale or never seeded → take it (writes the fresh marker).
      mirror.writeThrough(heldId(datasetId), { heldAt: nowIso });
      return 'acquired';
    },
    release(datasetId, nowIso) {
      mirror.writeThrough(tokenId(datasetId), { freedAt: nowIso });
      mirror.deleteThrough(heldId(datasetId));
    },
  };
}

// -------------------------------------------------------------- injection seam --

export type SyncDeps = {
  dataset?: (id: string) => Dataset | null;
  resolveOwner?: (ownerId: string) => Promise<CurrentUser | null>;
  /** The warehouse connection's external Trino catalog name, or null when the
   *  connection is missing / not a warehouse. */
  connectionCatalog?: (connId: string, user: CurrentUser) => Promise<string | null>;
  query?: (sql: string, principal?: string) => Promise<{ rows: string[][] }>;
  execute?: (sql: string, identity: ExecuteIdentity) => Promise<{ rowsAffected: number | null }>;
  /** Marks Bronze rebuilt (lights freshness — Monitoring reads versions.bronze.updatedAt). */
  markBronzeBuilt?: (id: string, owner: CurrentUser) => void;
  record?: typeof recordSyncRun;
  watermark?: (id: string) => string | null;
  quarantined?: (id: string) => boolean;
  lastMaintenance?: (id: string) => string | null;
  lease?: SyncLease;
  now?: () => string;
};

// The owner-resolver + connection lookup are imported LAZILY: they sit at the top of
// heavy server module graphs (agents runtime / connections store) the pure executor
// logic — and its unit tests, which inject fakes — never need loaded.
async function liveResolveOwner(ownerId: string): Promise<CurrentUser | null> {
  const { resolveOwner } = await import('../agents/build/scheduled.ts');
  return resolveOwner(ownerId);
}

async function liveConnectionCatalog(connId: string, user: CurrentUser): Promise<string | null> {
  try {
    const { getConnectionForUser } = await import('../connections/store.ts');
    const c = await getConnectionForUser(connId, user);
    return c.template === 'warehouse' && c.warehouse ? c.warehouse.catalog : null;
  } catch {
    return null;
  }
}

/** A deterministic, guard-safe per-slice batch id (same slice ⇒ same id, so a retry
 *  deletes exactly what its previous attempt landed). */
export function sliceBatchId(datasetId: string, highWatermark: string): string {
  const hw = highWatermark.replace(/[^A-Za-z0-9_.:-]+/g, '-');
  return `${datasetId}.${hw}`.replace(/[^A-Za-z0-9_.:-]+/g, '-');
}

/** Normalise a probed max(cursor) cell: empty table probes come back null/None. */
function normaliseProbe(v: string | undefined): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'None' || s === 'NULL' || s === 'null' ? null : s;
}

// ------------------------------------------------------------------ executor ---

export async function runDatasetSync(
  datasetId: string,
  trigger: SyncTrigger,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const getDs = deps.dataset ?? datasetForScheduler;
  const record = deps.record ?? recordSyncRun;
  const lease = deps.lease ?? mirrorLease();

  if (!deps.record) await ensureSyncRunsHydrated().catch(() => {});

  const d = getDs(datasetId);
  if (!d) return { ok: false, status: 404, error: 'Dataset not found' };
  const sync = d.sync;
  if (!sync) return { ok: false, status: 409, error: 'No sync is configured on this dataset' };

  if (trigger === 'schedule') {
    if (!sync.enabled) return { ok: true, skipped: true, reason: 'Sync is disabled' };
    if ((deps.quarantined ?? isQuarantined)(datasetId)) {
      return {
        ok: true,
        skipped: true,
        reason: 'Sync is quarantined after repeated failures — fix the source and press "Sync now" to resume',
      };
    }
  }

  // The OWNER's live identity — the agents scheduled-run contract: a deleted /
  // disabled / setup-incomplete owner fails the run cleanly, never a service fallback.
  const owner = await (deps.resolveOwner ?? liveResolveOwner)(d.owner);
  if (!owner) {
    return {
      ok: false,
      status: 409,
      error:
        `Sync refused: the dataset owner (${d.owner}) could not be resolved to an active ` +
        `user. Governed syncs run under the owner's identity and never fall back to a ` +
        `service principal.`,
    };
  }

  const startedAt = now();
  if ((await lease.acquire(datasetId, startedAt)) === 'held') {
    const run = record({
      datasetId,
      startedAt,
      finishedAt: now(),
      status: 'skipped',
      mode: sync.mode,
      error: 'Another sync run holds the lease',
      ranBy: owner.id,
    });
    return { ok: true, skipped: true, reason: 'Another sync run holds the lease', run };
  }

  const mode: DatasetSyncMode = trigger === 'reset' ? 'full-refresh' : sync.mode;
  const cursorBefore = trigger === 'reset' ? null : (deps.watermark ?? currentWatermark)(datasetId);
  const query = deps.query ?? ((sql: string, principal?: string) => queryRun(sql, principal));
  const execute = deps.execute ?? ((sql: string, identity: ExecuteIdentity) => executeRun(sql, identity));
  const identity: ExecuteIdentity = { principal: owner.id, uid: owner.id, domains: owner.domains, role: owner.role };
  const target: SyncTarget = { schema: personalSchema(owner.id), table: `bronze_${physicalSlug(d)}` };
  const targetFqn = `iceberg.${target.schema}.${target.table}`;

  try {
    const catalog = await (deps.connectionCatalog ?? liveConnectionCatalog)(sync.connectionId, owner);
    if (!catalog) throw new Error(`Connection ${sync.connectionId} is not an available warehouse connection`);
    const source: SyncSource = { catalog, schema: sync.source.schema, table: sync.source.table };

    // 1. Probe the high watermark BEFORE the write (a stable slice window even while
    //    the source keeps writing). Runs AS the owner — the same governed read a
    //    one-time import's CTAS performs.
    let highWatermark: string | null = null;
    const cursor = sync.cursor as SyncCursor | undefined;
    if (cursor && (cursor.kind === 'timestamp' || cursor.kind === 'number')) {
      const probe = await query(highWatermarkProbeSql(source, cursor), owner.id);
      highWatermark = normaliseProbe(probe.rows?.[0]?.[0]);
    }

    // 2. The write itself.
    let rowsAffected: number | null = null;
    let batchId: string | undefined;
    if (mode === 'full-refresh') {
      rowsAffected = (await execute(fullRefreshSql(target, source), identity)).rowsAffected;
    } else if (!cursor || (cursor.kind !== 'timestamp' && cursor.kind !== 'number')) {
      throw new Error(`Sync mode '${mode}' needs a timestamp or number cursor column`);
    } else if (highWatermark === null) {
      rowsAffected = 0; // empty source — honestly nothing to sync, cursor unchanged
    } else if (mode === 'append') {
      batchId = sliceBatchId(datasetId, highWatermark);
      const slice = {
        target, source, cursor,
        watermark: cursorBefore,
        highWatermark,
        lookbackMinutes: sync.lookbackMinutes,
        batchId,
        loadedAt: startedAt,
      };
      await execute(deleteBatchSql(target, batchId), identity); // retry idempotency (no-op first time)
      rowsAffected = (await execute(appendSql(slice), identity)).rowsAffected;
    } else {
      // merge: discover the target's columns (minus our lineage columns — the source
      // doesn't carry them) so the MERGE has an explicit, correct column list.
      const desc = await query(`describe ${targetFqn}`, owner.id);
      const columns = parseDescribe({ engine: '', tables: [], columns: [], rows: desc.rows, rowCount: desc.rows.length })
        .map((c) => c.name)
        .filter((n) => n !== '_loaded_at' && n !== '_batch_id');
      const { staging, merge, drop } = mergeSql({
        target, source, cursor,
        watermark: cursorBefore,
        highWatermark,
        lookbackMinutes: sync.lookbackMinutes,
        mergeKeys: sync.mergeKeys ?? [],
        columns,
      });
      await execute(staging, identity);
      rowsAffected = (await execute(merge, identity)).rowsAffected;
      await execute(drop, identity);
    }

    // 3. Write confirmed → NOW the cursor may advance, Bronze freshness lights, and
    //    already-built downstream layers are flagged stale (v1 never auto-rebuilds).
    const cursorAfter = cursor ? (highWatermark ?? cursorBefore) : null;
    const staleDownstream = (['silver', 'gold'] as const).filter((l: Layer) => d.versions[l].built) as ('silver' | 'gold')[];
    try {
      (deps.markBronzeBuilt ?? ((id: string, u: CurrentUser) => void buildVersion(id, u, 'bronze', {})))(datasetId, owner);
    } catch {
      /* freshness marking is additive — the landed data is already real */
    }

    // 4. Maintenance cadence (>24h): optimize (compaction) + expire_snapshots.
    //    Best-effort — a maintenance hiccup never fails a successful sync.
    let maintenance = false;
    const lastM = (deps.lastMaintenance ?? lastMaintenanceAt)(datasetId);
    if (lastM === null || Date.parse(startedAt) - Date.parse(lastM) > MAINTENANCE_INTERVAL_MS) {
      try {
        await execute(optimizeSql(target), identity);
        await execute(expireSnapshotsSql(target), identity);
        maintenance = true;
      } catch {
        maintenance = false;
      }
    }

    const run = record({
      datasetId,
      startedAt,
      finishedAt: now(),
      status: 'ok',
      mode,
      cursorBefore,
      cursorAfter,
      rowsAffected,
      ranBy: owner.id,
      ...(staleDownstream.length > 0 ? { staleDownstream } : {}),
      ...(maintenance ? { maintenance } : {}),
      ...(batchId ? { batchId } : {}),
    });
    return { ok: true, run };
  } catch (e) {
    // Honest failure row: the cursor does NOT advance, so the next run re-covers
    // the slice (idempotent by construction — the CronJob's backoffLimit retries).
    const run = record({
      datasetId,
      startedAt,
      finishedAt: now(),
      status: 'error',
      mode,
      cursorBefore,
      error: (e as Error).message,
      ranBy: owner.id,
    });
    return { ok: true, run };
  } finally {
    lease.release(datasetId, now());
  }
}
