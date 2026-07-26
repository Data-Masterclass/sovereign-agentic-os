/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '../infra/os-mirror.ts';
import type { DatasetSyncMode } from './dataset-schema.ts';

/**
 * Durable SYNC-RUN store — the time-series of scheduled-incremental-sync runs, one
 * row per run per dataset. A direct clone of the DQ-results pattern (`dq-results.ts`):
 * osMirror write-through + global-symbol in-process cache + its own `os-sync-runs`
 * OpenSearch index, trimmed to the recent window per dataset.
 *
 * This store is ALSO the sync's progress state: the CURRENT WATERMARK is derived as
 * `cursorAfter` of the latest ok run (never stored in dataset.yaml, so a config edit
 * can't clobber progress), QUARANTINE is derived from the trailing consecutive-error
 * count (an ok run — e.g. a manual "Sync now" — clears it automatically, no flag to
 * un-set), and the MAINTENANCE cadence reads the latest `maintenance:true` row.
 * Reads are honest: no run yet ⇒ empty list ⇒ "never synced", never a fabricated ok.
 */

/** 'running' is the DISPATCH marker: written BEFORE an append slice's INSERT so the
 *  planned window {cursorBefore, highWatermark, batchId} survives a client timeout
 *  or crash — the next attempt REUSES it (delete-by-batch-id + re-append the SAME
 *  slice) instead of probing a moved high watermark, which would duplicate rows.
 *  It is finalized in place to ok/error; a stale 'running' row means a crash. */
export type SyncRunStatus = 'ok' | 'error' | 'skipped' | 'running';

export type SyncRunRecord = {
  /** `${datasetId}:${startedAt}` — unique, sortable, one per run. */
  id: string;
  datasetId: string;
  startedAt: string;
  finishedAt: string;
  status: SyncRunStatus;
  mode: DatasetSyncMode;
  /** Cursor window this run covered (absent for full-refresh without a cursor). */
  cursorBefore?: string | null;
  cursorAfter?: string | null;
  /** The probed high watermark the run's slice was bounded to (kafka-offsets: the
   *  serialized offsets map). Persisted on 'running'/'error' rows so a retry can
   *  re-cover the EXACT same window (see SyncRunStatus). */
  highWatermark?: string | null;
  rowsAffected?: number | null;
  /** The honest failure message (status 'error') or skip reason (status 'skipped'). */
  error?: string;
  ranBy: string;
  /** Built downstream layers now OLDER than the fresh Bronze (v1 surfaces staleness,
   *  never auto-rebuilds). */
  staleDownstream?: ('silver' | 'gold')[];
  /** True when this run also ran Iceberg maintenance (optimize + expire_snapshots). */
  maintenance?: boolean;
  /** The deterministic `_batch_id` an append slice landed under. */
  batchId?: string;
};

/** How many recent runs per dataset stay hydrated for history + derivations. */
export const MAX_SYNC_RUNS_PER_DATASET = 50;

/** Consecutive-error threshold after which a sync is quarantined (auto-paused). */
export const QUARANTINE_THRESHOLD = 10;

const SYNC_RUNS_KEY = Symbol.for('soa.data.sync-runs.store');

type SyncRunsState = { runs: Map<string, SyncRunRecord>; hydration: Promise<void> | null };

function state(): SyncRunsState {
  const g = globalThis as unknown as Record<symbol, SyncRunsState | undefined>;
  if (!g[SYNC_RUNS_KEY]) g[SYNC_RUNS_KEY] = { runs: new Map(), hydration: null };
  return g[SYNC_RUNS_KEY]!;
}

const mirror = osMirror({
  index: 'os-sync-runs',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        datasetId: { type: 'keyword' },
        startedAt: { type: 'date' },
        finishedAt: { type: 'date' },
        status: { type: 'keyword' },
        mode: { type: 'keyword' },
        cursorBefore: { type: 'keyword' },
        cursorAfter: { type: 'keyword' },
        highWatermark: { type: 'keyword' },
        rowsAffected: { type: 'long' },
        error: { type: 'text' },
        ranBy: { type: 'keyword' },
        staleDownstream: { type: 'keyword' },
        maintenance: { type: 'boolean' },
        batchId: { type: 'keyword' },
      },
    },
  },
});

/** The lease mirror — `claim()` on `sync-lease:<datasetId>` gates run overlap. It is
 *  exported for the executor; rows in it are single-use lease docs, not run rows. */
export const syncRunsMirror = mirror;

export async function ensureSyncRunsHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = state();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const rec of docs as SyncRunRecord[]) {
    // Lease docs share the index but are not run rows — hydrate only real runs.
    if (rec.id && rec.datasetId && rec.startedAt && rec.status) s.runs.set(rec.id, rec);
  }
  trimAll(s);
}

/** Chronological (oldest→newest) runs for one dataset, in-process. */
function runsFor(s: SyncRunsState, datasetId: string): SyncRunRecord[] {
  return Array.from(s.runs.values())
    .filter((r) => r.datasetId === datasetId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function trimDataset(s: SyncRunsState, datasetId: string): void {
  const runs = runsFor(s, datasetId);
  const excess = runs.length - MAX_SYNC_RUNS_PER_DATASET;
  for (let i = 0; i < excess; i++) s.runs.delete(runs[i].id);
}

function trimAll(s: SyncRunsState): void {
  const ids = new Set(Array.from(s.runs.values()).map((r) => r.datasetId));
  for (const id of ids) trimDataset(s, id);
}

/** Append ONE run to the time-series (write-through). Same-millisecond runs are
 *  disambiguated so an append never clobbers a prior row. */
export function recordSyncRun(input: Omit<SyncRunRecord, 'id'>): SyncRunRecord {
  const s = state();
  let id = `${input.datasetId}:${input.startedAt}`;
  let salt = 1;
  while (s.runs.has(id)) id = `${input.datasetId}:${input.startedAt}#${salt++}`;
  const rec: SyncRunRecord = { id, ...input };
  s.runs.set(id, rec);
  trimDataset(s, input.datasetId);
  mirror.writeThrough(id, rec);
  return rec;
}

/** Finalize (or amend) ONE run row IN PLACE — how a 'running' dispatch marker
 *  becomes its ok/error row without leaving a stray duplicate in the history.
 *  Write-through; null when the row is unknown (caller then records a fresh row). */
export function updateSyncRun(id: string, patch: Partial<SyncRunRecord>): SyncRunRecord | null {
  const s = state();
  const rec = s.runs.get(id);
  if (!rec) return null;
  const next: SyncRunRecord = { ...rec, ...patch, id: rec.id, datasetId: rec.datasetId };
  s.runs.set(rec.id, next);
  mirror.writeThrough(rec.id, next);
  return next;
}

/** All retained runs for a dataset, oldest→newest. */
export function listSyncRuns(datasetId: string): SyncRunRecord[] {
  return runsFor(state(), datasetId);
}

/** The most recent run, or null when the dataset has never synced. */
export function latestSyncRun(datasetId: string): SyncRunRecord | null {
  const runs = runsFor(state(), datasetId);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/** The current incremental watermark: `cursorAfter` of the latest ok run. Null when
 *  no ok run (or the latest ok run recorded no cursor) — first-run semantics. */
export function currentWatermark(datasetId: string): string | null {
  const runs = runsFor(state(), datasetId);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === 'ok') return runs[i].cursorAfter ?? null;
  }
  return null;
}

/** Trailing consecutive errors (newest backwards). 'skipped' and 'running' rows are
 *  not evidence either way and are stepped over; an 'ok' run resets the streak. */
export function consecutiveErrorCount(datasetId: string): number {
  const runs = runsFor(state(), datasetId);
  let n = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === 'skipped' || runs[i].status === 'running') continue;
    if (runs[i].status !== 'error') break;
    n++;
  }
  return n;
}

/** DERIVED quarantine (auto-pause): ≥ threshold trailing consecutive errors. Any ok
 *  run — e.g. a manual "Sync now" that fixed things — clears it with no flag to reset. */
export function isQuarantined(datasetId: string, threshold = QUARANTINE_THRESHOLD): boolean {
  return consecutiveErrorCount(datasetId) >= threshold;
}

/** When maintenance (optimize + expire_snapshots) last ran, or null if never within
 *  the retained window. NOTE: the window keeps {@link MAX_SYNC_RUNS_PER_DATASET} runs,
 *  so a very frequent sync may "forget" old maintenance and re-run it early — harmless
 *  (maintenance is idempotent), never late in the other direction. */
export function lastMaintenanceAt(datasetId: string): string | null {
  const runs = runsFor(state(), datasetId);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].maintenance) return runs[i].finishedAt;
  }
  return null;
}

/** For tests only — reset in-process state without touching the mirror. */
export function __resetSyncRuns(): void {
  const g = globalThis as unknown as Record<symbol, SyncRunsState | undefined>;
  g[SYNC_RUNS_KEY] = { runs: new Map(), hydration: null };
}
