/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Sync status read-back — from Dagster when `DATA_PROJECT_GIT` is on, else the OS ledger
 * USER STORY: As a dataset owner I want "Sync status" (the panel, `get_sync_status`, Monitoring) to
 *             show the runs Dagster actually executed, whether the schedule is paused (quarantine)
 *             and the next tick — read from Dagster, not from a parallel OS ledger (checklist D9).
 * ARCHITECTURE:
 *   - ONE function both the route and the MCP tool call (`syncStatusFor`), so the two can never
 *     drift; `latestSyncSignals` is the batch form Monitoring's lists use (one TAG-FILTERED Dagster
 *     read per dataset, bounded concurrency — review B2-review-M4 explains why not one big read).
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
import { listRepos } from '@core/infra/git-store';
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
  dagster?: Pick<typeof dagster, 'runsForDataset' | 'nextTick'>;
  location?: string;
  flag?: () => boolean;
  now?: () => Date;
  /** Every domain with a repo. Needed to name a schedule whose domain's sanitized name collides
   *  with another's — the code location appends a digest then (review B2-review-M2, closed in B3).
   *  Default: the repos on disk. */
  domains?: () => Promise<string[]>;
};

/** Every domain that has a data-project repo, for collision-safe schedule naming. */
async function repoDomains(): Promise<string[]> {
  return (await listRepos()).map((r) => r.name);
}

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
  // The location resolves sanitize collisions with a digest, so the OS must know every domain to
  // name the schedule it actually defined (review B2-review-M2). A failed read degrades to the
  // plain form — the pre-B3 behaviour — never to an error.
  const allDomains = await (deps.domains ?? repoDomains)().catch(() => [] as string[]);
  const schedule = dagster.scheduleNameFor(d.domain, d.id, allDomains);
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

/**
 * `lastSync` is when the newest run ENDED (its start while still running) — never a guess.
 *
 * `unknown` separates "this dataset has never synced" from "we could not find out": with the flag
 * on it is `true` only when the Dagster read for that dataset failed. Consumers that do not care
 * may ignore it; a surface that renders "never" MUST not render it for an unknown (review
 * B2-review-M4).
 */
export type SyncSignal = { lastSync: string | null; syncStatus: SyncRunStatus | null; unknown?: boolean };

/** How many `runsForDataset` reads are in flight at once (Monitoring pages are bounded). */
const SIGNAL_CONCURRENCY = 6;

/**
 * The "last sync" signal for many datasets at once (Monitoring lists). Flag off ⇒ the ledger;
 * flag on ⇒ ONE `runsForDataset` read PER dataset, six at a time. Unknown ⇒ nulls + `unknown`,
 * never a fabricated run.
 *
 * Review B2-review-M4: this used to be a single `recentOsRuns(200)` with an EMPTY filter and then
 * group by the `os/dataset` tag. That silently under-reports — the newest 200 runs across the whole
 * instance are easily all maintenance and one busy dataset's syncs, and every other dataset then
 * reads as "never synced" although it synced an hour ago. There is no OR-over-tags in Dagster's
 * `RunsFilter`, so the honest read is per dataset: `runsForDataset(id, 1)` is a tag-filtered query
 * the event log indexes, and an empty result now genuinely means "no run".
 */
export async function latestSyncSignals(datasetIds: string[], deps: SyncStatusDeps = {}): Promise<Map<string, SyncSignal>> {
  const out = new Map<string, SyncSignal>();
  const on = (deps.flag ?? dataProjectGitEnabled)();
  if (!on) {
    await ensureSyncRunsHydrated().catch(() => {});
    for (const id of datasetIds) {
      const s = latestSyncRun(id);
      // Flag OFF is the pre-B2 payload byte for byte: `startedAt`. The "when it ENDED" reading
      // (B2-8) belongs to the Dagster path; changing it here would have moved a number no one
      // asked to move on an install that is not using Dagster at all (review B2-review-M6b).
      out.set(id, { lastSync: s ? s.startedAt : null, syncStatus: s?.status ?? null });
    }
    return out;
  }
  const dg = deps.dagster ?? dagster;
  const ids = [...new Set(datasetIds)];
  for (const id of ids) out.set(id, { lastSync: null, syncStatus: null });
  for (let i = 0; i < ids.length; i += SIGNAL_CONCURRENCY) {
    const slice = ids.slice(i, i + SIGNAL_CONCURRENCY);
    await Promise.all(
      slice.map(async (id) => {
        const runs = await dg.runsForDataset(id, 1);
        if (!runs.ok) {
          out.set(id, { lastSync: null, syncStatus: null, unknown: true });
          return;
        }
        const r = runs.data[0];
        if (!r) return; // no run for this dataset — an honest "never", not an unknown
        out.set(id, { lastSync: r.endedAt ?? r.startedAt, syncStatus: runStatusToSync(r.status) });
      }),
    );
  }
  return out;
}
