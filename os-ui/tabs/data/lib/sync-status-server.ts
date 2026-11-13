/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Sync status read-back — from Dagster when `DATA_PROJECT_GIT` is on, else the OS ledger
 * USER STORY: As a dataset owner I want "Sync status" (the panel, `get_sync_status`, Monitoring) to
 *             show the runs Dagster actually executed, whether the schedule is paused (quarantine)
 *             and the next tick — read from Dagster, not from a parallel OS ledger (checklist D9).
 * ARCHITECTURE:
 *   - `dagsterRunFor` is the run-ADDRESSED read behind `get_dagster_run` (D17): one run, resolved
 *     through the dataset version record that carries its id, hidden as `not_found` when that
 *     dataset is not one the caller can view.
 *   - ONE function both the route and the MCP tool call (`syncStatusFor`), so the two can never
 *     drift; `latestSyncSignals` is the batch form Monitoring's lists use (one TAG-FILTERED Dagster
 *     read per dataset, bounded concurrency — review B2-review-M4 explains why not one big read).
 *   - Flag OFF: the ledger-derived payload the surfaces shipped before B2 (`sync-runs.ts`), with
 *     `nextRunAt: null` — B4 deleted the CronJob provisioning and the sweeps, so nothing fires the
 *     saved cron and an estimated "next run" would be a fabrication (review H-3b).
 *   - Flag ON: `runsForDataset` (tag `os/dataset`) → the panel's run shape; `nextTick` of the
 *     schedule `<domain>__<datasetId>` → `nextRunAt` and `quarantined` (schedule STOPPED while the
 *     OS config says enabled); `consecutiveErrors` from the run list. `watermark` is `null` (B3:
 *     `max(cursor) from {{ this }}`); `lastMaintenanceAt` is `null` (the weekly job is Dagster's).
 *     A Dagster outage is reported in `dagster.error` with empty runs — never fabricated rows.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { LAYERS, type Dataset, type DatasetSyncMode, type Layer } from '@tabs/data/lib/dataset-schema';
import { listAllDatasets, listDatasets, type Principal } from '@tabs/data/lib/store';
import { dataProjectGitEnabled } from '@tabs/data/lib/dbt/commit';
import * as dagster from '@core/infra/dagster';
import { listRepos } from '@core/infra/git-store';
import {
  consecutiveErrorCount, currentWatermark, ensureSyncRunsHydrated, isQuarantined, lastMaintenanceAt, latestSyncRun, listSyncRuns,
  type SyncRunRecord, type SyncRunStatus,
} from '@tabs/data/lib/sync-runs';

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
  if (!on) {
    await ensureSyncRunsHydrated().catch(() => {});
    return {
      sync: d.sync ?? null,
      runs: listSyncRuns(d.id).slice(-20).reverse().map(ledgerView),
      watermark: currentWatermark(d.id),
      quarantined: isQuarantined(d.id),
      consecutiveErrors: consecutiveErrorCount(d.id),
      lastMaintenanceAt: lastMaintenanceAt(d.id),
      // NOT `nextCronRun(...)` (review H-3b). B4 deleted the CronJob provisioning and both
      // sweeps, so with the flag off NOTHING fires this cron — a timestamp here would be the
      // panel's most confident lie. `null` means "no next run is scheduled", which is the truth;
      // `source: 'ledger'` is how a surface knows WHY (the schedule pickers say it in words).
      nextRunAt: null,
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

/* ------------------------------------------------- one run, by its run id -- */

/**
 * `get_dagster_run` (checklist D17). A build/sync MCP call hands back a `dagsterRunId`; until now
 * the only way to read it was `get_sync_status(datasetId)`, which needs the dataset id the caller
 * may not have kept and answers with the dataset's whole run history. This is the run-addressed
 * read: ONE run, found through the dataset it was launched for.
 *
 * GOVERNANCE — the run is the addressed object, so it is hidden the way agent runs are hidden
 * (the B4-11 exception the conformance test already pins for every `runId`-addressed tool): a run
 * id that was never minted, and a run launched for a dataset the caller cannot see, are the SAME
 * `not_found`. That is why the lookup runs over the caller's VIEWABLE datasets and never calls
 * `getDataset`, whose 403 on an unviewable dataset would confirm the run exists.
 */
export type DagsterRunView = {
  runId: string;
  /** The dataset + layer whose version record carries this run id — the authorization anchor. */
  dataset: { id: string; name: string; domain: string; layer: Layer };
  /** The domain-repo commit the layer was launched from (`setVersionRun`), null when unrecorded. */
  commit: string | null;
  jobName: string | null;
  /** Dagster's own status; null when Dagster could not be read (see `dagsterError`). */
  status: dagster.RunStatus | null;
  /** The same ok|error|running vocabulary the sync panel and `get_sync_status` use. */
  syncStatus: SyncRunStatus | null;
  startedAt: string | null;
  endedAt: string | null;
  assetSelection: string[];
  /** ONLY the OS's own `os/*` tags. Dagster's internal tags (including the `dagster-k8s/config`
   *  env blob, which can name infrastructure) are NOT the caller's business. */
  tags: Record<string, string>;
  /** Why the run failed, or why it could not be launched. Null for a run that did not fail. */
  failure: string | null;
  /** Why Dagster could not be read at all — the read is reported, never faked as a status. */
  dagsterError: string | null;
};

export type DagsterRunDeps = {
  dagster?: Pick<typeof dagster, 'run'>;
  /** Every non-archived dataset, parsed. Default: the store. */
  datasets?: () => Dataset[];
  /** The ids the caller may view. Default: the store's DLS-scoped list. */
  viewable?: (viewer: Principal) => Set<string>;
};

class RunNotFound extends Error {
  readonly status = 404;
  constructor() {
    // Deliberately says nothing about which datasets exist or who owns them.
    super('Dagster run not found');
  }
}

function viewableIds(viewer: Principal): Set<string> {
  const g = listDatasets(viewer);
  return new Set([...g.mine, ...g.domain, ...g.marketplace].map((s) => s.id));
}

/** The dataset + layer whose version record carries `runId`, among the caller's VIEWABLE datasets. */
function anchorFor(runId: string, viewer: Principal, deps: DagsterRunDeps): { dataset: Dataset; layer: Layer } | null {
  const viewable = (deps.viewable ?? viewableIds)(viewer);
  for (const d of (deps.datasets ?? listAllDatasets)()) {
    if (!viewable.has(d.id)) continue;
    for (const layer of LAYERS) {
      if (d.versions[layer]?.dagsterRunId === runId) return { dataset: d, layer };
    }
  }
  return null;
}

export async function dagsterRunFor(runId: string, viewer: Principal, deps: DagsterRunDeps = {}): Promise<DagsterRunView> {
  const id = (runId ?? '').trim();
  const anchor = id ? anchorFor(id, viewer, deps) : null;
  if (!anchor) throw new RunNotFound();
  const { dataset: d, layer } = anchor;
  const version = d.versions[layer];
  const base = {
    runId: id,
    dataset: { id: d.id, name: d.name, domain: d.domain, layer },
    commit: version?.commit ?? null,
  };

  const r = await (deps.dagster ?? dagster).run(id);
  if (!r.ok) {
    // Dagster unreachable, or it does not know this id. Either way the OS does not invent a
    // status — it reports what it recorded at launch and why the live read failed.
    return {
      ...base,
      jobName: null,
      status: null,
      syncStatus: null,
      startedAt: null,
      endedAt: null,
      assetSelection: [],
      tags: {},
      failure: version?.launchError ?? null,
      dagsterError: r.error,
    };
  }

  const run = r.data;
  const osTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(run.tags)) if (k.startsWith('os/')) osTags[k] = v;
  const syncStatus = runStatusToSync(run.status);
  return {
    ...base,
    jobName: run.jobName || null,
    status: run.status,
    syncStatus,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    assetSelection: run.assetSelection,
    tags: osTags,
    // The step-level message lives in Dagster's event log, which this read does not fetch — so the
    // failure line says WHAT failed and WHERE to look, and never invents a cause. A recorded
    // `launchError` (no run was ever launched) wins, because it is the more specific truth.
    failure:
      version?.launchError ??
      (syncStatus === 'error'
        ? `Dagster run ${run.status.toLowerCase()}${run.jobName ? ` (${run.jobName})` : ''} — the step error is in the Dagster run's event log.`
        : null),
    dagsterError: null,
  };
}
