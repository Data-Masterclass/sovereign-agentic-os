/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { SalesforceSliceArgs } from '../connections/salesforce.ts';
import type { KajabiSliceArgs } from '../connections/kajabi.ts';
import type { ODataSliceArgs } from '../connections/odata/sync.ts';
import type { WorkdaySliceArgs } from '../connections/workday-raas.ts';
import type { OperationalPlatform } from '../connections/operational-platform.ts';
import { config } from '../core/config.ts';
import { executeRun, queryRun, type ExecuteIdentity } from '../infra/governed.ts';
import type { Dataset, DatasetSyncMode, Layer } from './dataset-schema.ts';
import { buildVersion, datasetForScheduler } from './store.ts';
import { domainSchema, personalSchema, physicalSlug } from './store-fqn.ts';
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
  apiPlatform?: (connId: string, user: CurrentUser) => Promise<OperationalPlatform>;
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
  /** The API-BATCH slice runner (OData — sap-odata / odata-v4). */
  odataSlice?: (
    args: ODataSliceArgs,
  ) => Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }>;
  /** The API-BATCH slice runner (Workday RaaS). */
  workdaySlice?: (
    args: WorkdaySliceArgs,
  ) => Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }>;
  /** The Salesforce `/limits` pre-flight (DailyApiRequests usage). Null ⇒ no signal
   *  (proceed unchanged). Injected for tests; the live impl reads AS the sync owner. */
  apiUsage?: (connId: string, user: CurrentUser) => Promise<{ max: number; remaining: number } | null>;
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

async function liveODataSlice(
  args: ODataSliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runODataSlice } = await import('../connections/odata/sync.ts');
  return runODataSlice(args);
}

async function liveWorkdaySlice(
  args: WorkdaySliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const { runWorkdaySlice } = await import('../connections/workday-raas.ts');
  return runWorkdaySlice(args);
}

/** The live Salesforce `/limits` pre-flight — resolves + reads AS the sync owner. Never
 *  throws (a limits hiccup never fails an otherwise-fine sync); null ⇒ proceed unchanged. */
async function liveApiUsage(connId: string, user: CurrentUser): Promise<{ max: number; remaining: number } | null> {
  const { salesforceApiUsage } = await import('../connections/salesforce.ts');
  return salesforceApiUsage(connId, user);
}

/** Which api-batch platform a non-catalog connection is — now resolved through the
 *  operational registry (`platformForTemplate`), so a new operational template appends
 *  there only. 'salesforce' on any failure / unknown template — the Salesforce slice
 *  runner then re-resolves and throws the honest "not an available sync source" error
 *  under the caller's identity (byte-identical to the prior hardcoded switch's default). */
async function liveApiPlatform(connId: string, user: CurrentUser): Promise<OperationalPlatform> {
  try {
    const { getConnectionForUser } = await import('../connections/store.ts');
    const { platformForTemplate } = await import('../connections/operational-registry.ts');
    const c = await getConnectionForUser(connId, user);
    return platformForTemplate(c.template);
  } catch {
    return 'salesforce';
  }
}

/**
 * The Iceberg TARGET a sync run lands into — the ONE seam that differs between an
 * ingest/curated sync and an adopted CONNECTED · SYNC dataset (lakehouse-import-exposure.md,
 * Phase 3). PURE (no session, no network) so the executor and its tests share it:
 *   • a CONNECTED · SYNC dataset lands its GOVERNED COPY straight into the DOMAIN schema at
 *     the declared tier — `iceberg.<domainSchema>.<tier>_<slug>` — matching the FQN seam
 *     (`store-fqn.versionTarget`) preview/profile/DQ/Talk/metrics read. It runs AS the
 *     adopting domain's principal, entitled to its own domain schema (trino.rego write floor).
 *   • every OTHER sync (the classic warehouse/API import) keeps landing in the owner's
 *     PERSONAL lane at bronze — `iceberg.personal_<owner>.bronze_<slug>` — unchanged.
 */
export function syncTargetFor(d: Dataset, owner: { id: string }): SyncTarget {
  if (d.connected && d.connected.mode === 'sync') {
    return { schema: domainSchema(d.domain), table: `${d.connected.tier}_${physicalSlug(d)}` };
  }
  return { schema: personalSchema(owner.id), table: `bronze_${physicalSlug(d)}` };
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
  // A CONNECTED · SYNC dataset lands its governed copy AS its adopting DOMAIN principal
  // (entitled to its domain schema by the trino.rego write floor); every other sync lands
  // in the owner's personal lane AS the owner. The identity's principal must own the target
  // schema (personal ⇒ owner id; domain ⇒ the domain), so the two never drift.
  const connectedSync = !!(d.connected && d.connected.mode === 'sync');
  const target: SyncTarget = syncTargetFor(d, owner);
  const writePrincipal = connectedSync ? (owner.domains[0] ?? owner.id) : owner.id;
  const identity: ExecuteIdentity = { principal: writePrincipal, uid: owner.id, domains: owner.domains, role: owner.role };
  // Governed READS of the source. A connected-sync source is an EXPOSED external table —
  // the exposure grants the adopting DOMAIN, so the watermark probe / describe read AS the
  // domain principal (matching the write). Every other sync reads AS the owner (personal lane).
  const readPrincipal = writePrincipal;
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

    // Shared SUCCESS tail — cursor advance, freshness marking, stale flags, Iceberg
    // maintenance, the ok run row. BOTH strategies end here (steps 3 + 4).
    const finish = async (): Promise<SyncOutcome> => {
      // 3. Write confirmed → NOW the cursor may advance, the landed layer's freshness
      //    lights (EARNED status — the tier version only turns `built` after a real landing),
      //    and already-built downstream layers are flagged stale (v1 never auto-rebuilds).
      const cursorAfter = cursor ? (highWatermark ?? cursorBefore) : null;
      // A connected-sync dataset lights the DECLARED TIER (its copy IS that tier); every
      // other sync lights bronze (the personal-lane landing). Downstream-stale is only
      // meaningful for the bronze→silver→gold chain, which a connected-sync dataset lacks.
      const landedLayer: Layer = connectedSync ? d.connected!.tier : 'bronze';
      const staleDownstream = connectedSync
        ? []
        : ((['silver', 'gold'] as const).filter((l: Layer) => d.versions[l].built) as ('silver' | 'gold')[]);
      try {
        (deps.markBronzeBuilt ?? ((id: string, u: CurrentUser) => void buildVersion(id, u, landedLayer, {})))(datasetId, owner);
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
      // ---- api-batch (Salesforce / Kajabi / OData / Workday) ----
      const platform = await (deps.apiPlatform ?? liveApiPlatform)(sync.connectionId, owner);
      if (mode === 'merge') {
        const label = platform === 'kajabi' ? 'Kajabi' : platform === 'odata' ? 'OData' : platform === 'workday' ? 'Workday RaaS' : 'Salesforce';
        throw new Error(`${label} sync supports append or full-refresh only (merge needs a federated SQL source)`);
      }
      // QUOTA PRE-FLIGHT (Salesforce): read the org's real DailyApiRequests before pulling
      // pages. Near quota ⇒ SKIP honestly ("throttled — resuming next window") with the
      // real numbers in the reason (Developer view) and the cursor UNADVANCED — never a
      // hard 429 mid-slice. Nil-safe: absent /limits data (null) changes NOTHING.
      if (platform === 'salesforce') {
        const usage = await (deps.apiUsage ?? liveApiUsage)(sync.connectionId, owner).catch(() => null);
        const { nearApiQuota } = await import('../connections/salesforce.ts');
        if (nearApiQuota(usage)) {
          const reason =
            `throttled — resuming next window (Salesforce DailyApiRequests ${usage!.remaining}/${usage!.max} remaining, below the safety floor)`;
          const run = record({ datasetId, startedAt, finishedAt: now(), status: 'skipped', mode, cursorBefore, ranBy: owner.id, error: reason });
          return { ok: true, skipped: true, reason, run };
        }
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
      // Slice dispatch through the operational registry — the same disjoint-branch
      // registry the discovery/cursor seams use. The test injection seams
      // (deps.salesforceSlice/kajabiSlice) forward straight through, so the executor's
      // fakes still bind; the live path resolves the platform runner lazily.
      const { pullOperationalSlice } = await import('../connections/operational-registry.ts');
      const sliced = await pullOperationalSlice(platform, common, sync.source.table, {
        salesforceSlice: deps.salesforceSlice ?? liveSalesforceSlice,
        kajabiSlice: deps.kajabiSlice ?? liveKajabiSlice,
        odataSlice: deps.odataSlice ?? liveODataSlice,
        workdaySlice: deps.workdaySlice ?? liveWorkdaySlice,
      });
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
        const probe = await query(highWatermarkProbeSql(source, cursor), readPrincipal);
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
        const probe = await query(kafkaOffsetsProbeSql(source), readPrincipal);
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
      const desc = await query(`describe ${targetFqn}`, readPrincipal);
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
