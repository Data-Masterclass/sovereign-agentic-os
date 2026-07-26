/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { SalesforceSliceArgs } from '../connections/salesforce.ts';
import type { KajabiSliceArgs } from '../connections/kajabi.ts';
import { config } from '../core/config.ts';
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
  kafkaAppendSql,
  kafkaFullLoadSql,
  kafkaHasNew,
  kafkaOffsetsProbeSql,
  mergeKafkaOffsets,
  mergeSql,
  optimizeSql,
  parseKafkaOffsets,
  serializeKafkaOffsets,
  type KafkaOffsets,
  type SyncCursor,
  type SyncSource,
  type SyncTarget,
} from './sync-sql.ts';
import {
  currentWatermark,
  ensureSyncRunsHydrated,
  isQuarantined,
  lastMaintenanceAt,
  latestSyncRun,
  recordSyncRun,
  syncRunsMirror,
  updateSyncRun,
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
   *  connection is missing / not a warehouse. A null answer falls through to the
   *  API-BATCH strategy (Salesforce / Kajabi) — see `apiPlatform`. */
  connectionCatalog?: (connId: string, user: CurrentUser) => Promise<string | null>;
  /** Which API-BATCH platform a NON-catalog connection is. Defaults to
   *  'salesforce' when unresolvable so the Salesforce slice runner surfaces its
   *  honest "not an available sync source" error (never a silent success). */
  apiPlatform?: (connId: string, user: CurrentUser) => Promise<'salesforce' | 'kajabi'>;
  /** The API-BATCH slice runner (Salesforce): pulls the slice via the REST API and
   *  streams it to the data-runner. The live impl resolves + validates the
   *  connection itself and throws an honest error when it is no sync source. */
  salesforceSlice?: (
    args: SalesforceSliceArgs,
  ) => Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }>;
  /** The API-BATCH slice runner (Kajabi) — the Kajabi peer of `salesforceSlice`. */
  kajabiSlice?: (
    args: KajabiSliceArgs,
  ) => Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }>;
  query?: (sql: string, principal?: string) => Promise<{ rows: string[][] }>;
  execute?: (sql: string, identity: ExecuteIdentity) => Promise<{ rowsAffected: number | null }>;
  /** Marks Bronze rebuilt (lights freshness — Monitoring reads versions.bronze.updatedAt). */
  markBronzeBuilt?: (id: string, owner: CurrentUser) => void;
  record?: typeof recordSyncRun;
  /** Finalize the 'running' dispatch marker in place (defaults to the real store). */
  update?: typeof updateSyncRun;
  /** The most recent run row — the retry-window source (error/'running' + window). */
  latestRun?: (id: string) => SyncRunRecord | null;
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

async function liveSalesforceSlice(
  args: SalesforceSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runSalesforceSlice } = await import('../connections/salesforce.ts');
  return runSalesforceSlice(args);
}

async function liveKajabiSlice(
  args: KajabiSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runKajabiSlice } = await import('../connections/kajabi.ts');
  return runKajabiSlice(args);
}

/** Which api-batch platform a non-catalog connection is. 'salesforce' on any
 *  failure — the Salesforce slice runner then re-resolves and throws the honest
 *  "not an available sync source" error under the caller's identity. */
async function liveApiPlatform(connId: string, user: CurrentUser): Promise<'salesforce' | 'kajabi'> {
  try {
    const { getConnectionForUser } = await import('../connections/store.ts');
    const c = await getConnectionForUser(connId, user);
    return c.template === 'kajabi-api' ? 'kajabi' : 'salesforce';
  } catch {
    return 'salesforce';
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
  // Sync slices routinely outlive the interactive 15s default — the executor runs
  // with its own statement budget (SYNC_STATEMENT_TIMEOUT_MS, well below the lease).
  const execute =
    deps.execute ??
    ((sql: string, identity: ExecuteIdentity) => executeRun(sql, identity, undefined, config.syncStatementTimeoutMs));
  const identity: ExecuteIdentity = { principal: owner.id, uid: owner.id, domains: owner.domains, role: owner.role };
  const target: SyncTarget = { schema: personalSchema(owner.id), table: `bronze_${physicalSlug(d)}` };
  const targetFqn = `iceberg.${target.schema}.${target.table}`;

  // The DISPATCH-marker row id ('running' → finalized in place to ok/error).
  let pendingRunId: string | null = null;

  try {
    // STRATEGY: 'federated-sql' when the connection mounts a Trino catalog (every
    // warehouse/operational-db/kafka source), 'api-batch' when it does not
    // (Salesforce / Kajabi — Trino cannot reach them; the slice is pulled over REST
    // and streamed to the data-runner). Both run AS the owner, both advance the
    // cursor only after the landing succeeded.
    const catalog = await (deps.connectionCatalog ?? liveConnectionCatalog)(sync.connectionId, owner);
    let highWatermark: string | null = null;
    let rowsAffected: number | null = null;
    let batchId: string | undefined;
    const cursor = sync.cursor as SyncCursor | undefined;

    // DETERMINISTIC RETRY WINDOW (append). If the previous attempt for this SAME
    // watermark dispatched a slice but never confirmed success — an 'error' row, or
    // a stale 'running' marker left by a crash/client timeout whose INSERT may have
    // SUCCEEDED in Trino — REUSE its probed high watermark: the deterministic batch
    // id recomputes identically, delete-by-batch-id un-lands the earlier attempt,
    // and the SAME slice re-appends. Probing fresh would move the window, mint a
    // different batch id, and the idempotent delete would never fire → duplicates.
    // Only after a confirmed success does the next run probe a fresh watermark.
    const prior = (deps.latestRun ?? latestSyncRun)(datasetId);
    const staleWindow =
      mode === 'append' &&
      prior &&
      (prior.status === 'error' || prior.status === 'running') &&
      prior.mode === 'append' &&
      prior.batchId &&
      prior.highWatermark !== undefined &&
      prior.highWatermark !== null &&
      (prior.cursorBefore ?? null) === cursorBefore
        ? { highWatermark: prior.highWatermark }
        : null;

    // The dispatch marker: persist {cursorBefore, highWatermark, batchId} BEFORE the
    // INSERT flies, so even a crash leaves enough to retry the exact slice.
    const update = deps.update ?? updateSyncRun;
    const markDispatch = (): void => {
      pendingRunId = record({
        datasetId,
        startedAt,
        finishedAt: startedAt,
        status: 'running',
        mode,
        cursorBefore,
        highWatermark,
        ranBy: owner.id,
        ...(batchId ? { batchId } : {}),
      }).id;
    };

    // Shared SUCCESS tail — cursor advance, Bronze freshness, stale flags, Iceberg
    // maintenance, the ok run row. BOTH strategies end here (steps 3 + 4).
    const finish = async (): Promise<SyncOutcome> => {
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

      const done = {
        finishedAt: now(),
        status: 'ok' as const,
        mode,
        cursorBefore,
        cursorAfter,
        rowsAffected,
        ...(staleDownstream.length > 0 ? { staleDownstream } : {}),
        ...(maintenance ? { maintenance } : {}),
        ...(batchId ? { batchId } : {}),
      };
      // Finalize the dispatch marker in place; fall back to a fresh row when none
      // was written (full-refresh / merge / zero-row runs) or it is unknown.
      const run =
        (pendingRunId ? update(pendingRunId, done) : null) ??
        record({ datasetId, startedAt, ranBy: owner.id, ...done });
      return { ok: true, run };
    };

    if (!catalog) {
      // ---- api-batch (Salesforce / Kajabi) ----
      const platform = await (deps.apiPlatform ?? liveApiPlatform)(sync.connectionId, owner);
      if (mode === 'merge') {
        throw new Error(
          `${platform === 'kajabi' ? 'Kajabi' : 'Salesforce'} sync supports append or full-refresh only (merge needs a federated SQL source)`,
        );
      }
      // Both runners share the executor contract: probe/reuse the window, delete
      // the deterministic batch, stream pages to the data-runner, return the hw.
      const common = {
        connectionId: sync.connectionId,
        owner,
        mode: mode as 'full-refresh' | 'append',
        watermark: cursorBefore,
        datasetSlug: physicalSlug(d),
        target,
        identity,
        execute,
        mkBatchId: (hw: string) => sliceBatchId(datasetId, hw),
        // Deterministic retry: reuse an unconfirmed attempt's window, and persist
        // the planned window as the 'running' marker BEFORE any row lands.
        window: staleWindow,
        onWindow: (hw: string, bid: string) => {
          highWatermark = hw;
          batchId = bid;
          markDispatch();
        },
        startedAt,
      };
      const sliced =
        platform === 'kajabi'
          ? await (deps.kajabiSlice ?? liveKajabiSlice)({ ...common, resource: sync.source.table })
          : await (deps.salesforceSlice ?? liveSalesforceSlice)({ ...common, object: sync.source.table });
      rowsAffected = sliced.rowsAffected;
      batchId = sliced.batchId;
      highWatermark = sliced.highWatermark;
      return finish();
    }
    const source: SyncSource = { catalog, schema: sync.source.schema, table: sync.source.table };

    // 1. Probe the high watermark BEFORE the write (a stable slice window even while
    //    the source keeps writing). Runs AS the owner — the same governed read a
    //    one-time import's CTAS performs.
    if (cursor && (cursor.kind === 'timestamp' || cursor.kind === 'number')) {
      if (staleWindow) {
        highWatermark = staleWindow.highWatermark; // re-cover the unconfirmed slice
      } else {
        const probe = await query(highWatermarkProbeSql(source, cursor), owner.id);
        highWatermark = normaliseProbe(probe.rows?.[0]?.[0]);
      }
    }

    // 2. The write itself.
    if (cursor?.kind === 'kafka-offsets') {
      // KAFKA OFFSET SYNC (append-only). The "high watermark" is the per-partition
      // offsets map, serialized as canonical JSON into the same cursor fields.
      // First load / reset is a CREATE OR REPLACE CTAS bounded to the probed highs
      // — which also CREATES the Bronze copy (Kafka has no one-time import);
      // incremental runs are delete-batch + INSERT of the per-partition windows.
      if (mode === 'merge') {
        throw new Error('Kafka sync is append-only — merge is not supported for kafka-offsets cursors');
      }
      const before = parseKafkaOffsets(cursorBefore); // null ⇒ first load (or reset)
      // Retry-window reuse (incremental only): a failed/crashed attempt re-covers
      // ITS OWN offsets window instead of probing moved partition highs.
      let highs: KafkaOffsets | null =
        before !== null && staleWindow ? parseKafkaOffsets(staleWindow.highWatermark) : null;
      if (!highs) {
        const probe = await query(kafkaOffsetsProbeSql(source), owner.id);
        highs = {};
        for (const row of probe.rows ?? []) {
          const pid = normaliseProbe(row?.[0]);
          const hi = normaliseProbe(row?.[1]);
          if (pid !== null && hi !== null) highs[pid] = hi;
        }
      }
      if (Object.keys(highs).length === 0) {
        rowsAffected = 0; // empty topic(s) — honestly nothing to sync, cursor unchanged
      } else {
        highWatermark = serializeKafkaOffsets(mergeKafkaOffsets(before, highs));
        if (before === null) {
          // First load / reset: CREATE OR REPLACE is its own idempotency — no
          // dispatch marker needed (a retry simply replaces the copy).
          batchId = sliceBatchId(datasetId, highWatermark);
          rowsAffected = (
            await execute(kafkaFullLoadSql({ target, source, highs, batchId, loadedAt: startedAt }), identity)
          ).rowsAffected;
        } else if (!kafkaHasNew(before, highs)) {
          rowsAffected = 0; // probed, nothing advanced — cursor keeps (merged) marks
        } else {
          batchId = sliceBatchId(datasetId, highWatermark);
          markDispatch(); // persist the window BEFORE the INSERT flies
          await execute(deleteBatchSql(target, batchId), identity); // retry idempotency
          rowsAffected = (
            await execute(kafkaAppendSql({ target, source, before, highs, batchId, loadedAt: startedAt }), identity)
          ).rowsAffected;
        }
      }
    } else if (mode === 'full-refresh') {
      rowsAffected = (await execute(fullRefreshSql(target, source), identity)).rowsAffected;
    } else if (!cursor || (cursor.kind !== 'timestamp' && cursor.kind !== 'number')) {
      throw new Error(`Sync mode '${mode}' needs a timestamp or number cursor column`);
    } else if (highWatermark === null) {
      rowsAffected = 0; // empty source — honestly nothing to sync, cursor unchanged
    } else if (mode === 'append') {
      // The batch id is deterministic on (dataset, HW) — with a reused window it
      // recomputes to the earlier attempt's id, so the delete un-lands exactly it.
      batchId = sliceBatchId(datasetId, highWatermark);
      const slice = {
        target, source, cursor,
        watermark: cursorBefore,
        highWatermark,
        lookbackMinutes: sync.lookbackMinutes,
        batchId,
        loadedAt: startedAt,
      };
      markDispatch(); // persist the window BEFORE the INSERT flies
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

    return finish();
  } catch (e) {
    // Honest failure row: the cursor does NOT advance, so the next run re-covers
    // the slice. A finalized dispatch marker KEEPS its {highWatermark, batchId}, so
    // that retry re-covers the SAME window (deterministic — never a fresh probe
    // over an unconfirmed slice).
    const fail = {
      finishedAt: now(),
      status: 'error' as const,
      mode,
      cursorBefore,
      error: (e as Error).message,
    };
    const run =
      (pendingRunId ? (deps.update ?? updateSyncRun)(pendingRunId, fail) : null) ??
      record({ datasetId, startedAt, ranBy: owner.id, ...fail });
    return { ok: true, run };
  } finally {
    lease.release(datasetId, now());
  }
}
