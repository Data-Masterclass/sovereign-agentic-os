/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Sync status read-back — from Dagster when `DATA_PROJECT_GIT` is on, else the OS ledger
 * USER STORY: As a dataset owner I want "Sync status" (the panel, `get_sync_status`, Monitoring) to
 *             show the runs Dagster actually executed, whether the schedule is paused (quarantine)
 *             and the next tick — read from Dagster, not from a parallel OS ledger (checklist D9).
 * ARCHITECTURE:
 *   - ONE function both the route and the MCP tool call (`syncStatusFor`), so the two can never
 *     drift; `latestSyncSignals` is the batch form Monitoring's lists use (one Dagster round trip).
 *   - Flag OFF: exactly the ledger-derived payload the surfaces shipped before B2 (`sync-runs.ts`).
 *   - Flag ON: `runsForDataset` (tag `os/dataset`) → the panel's run shape; `nextTick` of the
 *     schedule `<domain>__<datasetId>` → `nextRunAt` and `quarantined` (schedule STOPPED while the
 *     OS config says enabled); `consecutiveErrors` from the run list. `watermark` is `null` (B3:
 *     `max(cursor) from {{ this }}`); `lastMaintenanceAt` is `null` (the weekly job is Dagster's).
 *     A Dagster outage is reported in `dagster.error` with empty runs — never fabricated rows.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import type { Dataset, DatasetSyncMode } from '@tabs/data/lib/dataset-schema';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import * as dagster from '@core/infra/dagster';
import {
  consecutiveErrorCount, currentWatermark, ensureSyncRunsHydrated, isQuarantined, lastMaintenanceAt, latestSyncRun, listSyncRuns,
  type SyncRunRecord, type SyncRunStatus,
} from '@tabs/data/lib/sync-runs';
import { nextCronRun } from '@tabs/data/lib/sync-next-run';

/** The run row the SyncPanel renders (a subset of the ledger record, plus the Dagster id). */
export type SyncRunView = {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  status: SyncRunStatus;
  mode: DatasetSyncMode | string;
  rowsAffected?: number | null;
  cursorAfter?: string | null;
  error?: string;
  maintenance?: boolean;
  batchId?: string;
  dagsterRunId?: string;
  commit?: string;
  ranBy?: string;
};

export type SyncStatusView = {
  sync: Dataset['sync'] | null;
  runs: SyncRunView[];
  watermark: string | null;
  quarantined: boolean;
  consecutiveErrors: number;
  lastMaintenanceAt: string | null;
  nextRunAt: string | null;
  source: 'ledger' | 'dagster';
  dagster?: { schedule: string; location: string; status: 'RUNNING' | 'STOPPED' | null; error: string | null };
};

export type SyncStatusDeps = {
  dagster?: Pick<typeof dagster, 'runsForDataset' | 'nextTick' | 'recentOsRuns'>;
  location?: string;
  flag?: () => boolean;
  now?: () => Date;
};

/** Dagster run status → the panel's vocabulary. */
export function runStatusToSync(status: dagster.RunStatus): SyncRunStatus {
  if (status === 'SUCCESS') return 'ok';
  if (status === 'FAILURE' || status === 'CANCELED') return 'error';
  return 'running';
}

export function runToView(r: dagster.DagsterRun, mode: string): SyncRunView {
  const status = runStatusToSync(r.status);
  return {
    id: r.runId,
    dagsterRunId: r.runId,
    startedAt: r.startedAt ?? new Date(0).toISOString(),
    finishedAt: r.endedAt,
    status,
    mode: r.tags['os/full_refresh'] === 'true' ? 'full-refresh' : mode,
    ...(status === 'error' ? { error: `Dagster run ${r.status.toLowerCase()} (${r.jobName})` } : {}),
    ...(r.tags['os/batch_id'] ? { batchId: r.tags['os/batch_id'] } : {}),
    ...(r.tags['os/commit'] ? { commit: r.tags['os/commit'] } : {}),
    ...(r.tags['os/principal'] ? { ranBy: r.tags['os/principal'] } : {}),
    ...(r.tags['os/action'] === 'iceberg maintenance' ? { maintenance: true } : {}),
  };
}

/** Trailing consecutive failures, newest first; in-flight runs are stepped over. */
export function consecutiveFailures(runs: dagster.DagsterRun[]): number {
  let n = 0;
  for (const r of runs) {
    if (r.status === 'SUCCESS') break;
    if (r.status === 'FAILURE') n++;
  }
  return n;
}

function ledgerView(record: SyncRunRecord): SyncRunView {
  return record;
}

/** The sync status of one dataset — route and MCP tool share this. */
export async function syncStatusFor(d: Dataset, deps: SyncStatusDeps = {}): Promise<SyncStatusView> {
  const on = (deps.flag ?? dataProjectGitEnabled)();
  const now = deps.now ?? (() => new Date());
  if (!on) {
    await ensureSyncRunsHydrated().catch(() => {});
    const next = d.sync?.enabled ? nextCronRun(d.sync.schedule.cron, now()) : null;
    return {
      sync: d.sync ?? null,
      runs: listSyncRuns(d.id).slice(-20).reverse().map(ledgerView),
      watermark: currentWatermark(d.id),
      quarantined: isQuarantined(d.id),
      consecutiveErrors: consecutiveErrorCount(d.id),
      lastMaintenanceAt: lastMaintenanceAt(d.id),
      nextRunAt: next ? next.toISOString() : null,
      source: 'ledger',
    };
  }
  const dg = deps.dagster ?? dagster;
  const schedule = dagster.scheduleNameFor(d.domain, d.id);
  const [runs, tick] = await Promise.all([dg.runsForDataset(d.id, 20), d.sync ? dg.nextTick(schedule) : Promise.resolve(null)]);
  const list = runs.ok ? runs.data : [];
  const tickData = tick && tick.ok ? tick.data : null;
  const error = !runs.ok ? runs.error : tick && !tick.ok ? tick.error : null;
  return {
    sync: d.sync ?? null,
    runs: list.map((r) => runToView(r, d.sync?.mode ?? 'full-refresh')),
    watermark: null,
    // Paused in Dagster while the OS config says enabled ⇒ quarantined (the failure sensor, or the
    // inactive-principal sensor, or a human in the Dagster UI stopped it).
    quarantined: Boolean(d.sync?.enabled && tickData && tickData.status === 'STOPPED'),
    consecutiveErrors: consecutiveFailures(list),
    lastMaintenanceAt: null,
    nextRunAt: tickData?.nextTickAt ?? null,
    source: 'dagster',
    dagster: { schedule, location: deps.location ?? config.dagsterLocation, status: tickData?.status ?? null, error },
  };
}

/** `lastSync` is when the newest run ENDED (its start while still running) — never a guess. */
export type SyncSignal = { lastSync: string | null; syncStatus: SyncRunStatus | null };

/**
 * The "last sync" signal for many datasets at once (Monitoring lists). Flag off ⇒ the ledger;
 * flag on ⇒ ONE `runsOrError` read grouped by `os/dataset`. Unknown ⇒ nulls, never a fabricated run.
 */
export async function latestSyncSignals(datasetIds: string[], deps: SyncStatusDeps = {}): Promise<Map<string, SyncSignal>> {
  const out = new Map<string, SyncSignal>();
  const on = (deps.flag ?? dataProjectGitEnabled)();
  if (!on) {
    await ensureSyncRunsHydrated().catch(() => {});
    for (const id of datasetIds) {
      const s = latestSyncRun(id);
      out.set(id, { lastSync: s ? (s.finishedAt ?? s.startedAt) : null, syncStatus: s?.status ?? null });
    }
    return out;
  }
  const dg = deps.dagster ?? dagster;
  const runs = await dg.recentOsRuns(200);
  for (const id of datasetIds) out.set(id, { lastSync: null, syncStatus: null });
  if (!runs.ok) return out;
  for (const r of runs.data) {
    const id = r.tags['os/dataset'];
    if (!id || !out.has(id)) continue;
    const cur = out.get(id)!;
    if (cur.syncStatus) continue; // newest first — keep the first seen
    out.set(id, { lastSync: r.endedAt ?? r.startedAt, syncStatus: runStatusToSync(r.status) });
  }
  return out;
}
