/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Launch a Dagster run for a dataset AFTER its commit landed (engine rebuild B2)
 * USER STORY: As a data engineer I want a Build, a Silver transform, a Gold join or "Sync now" to
 *             commit my domain's dbt project and then materialise exactly that selection in Dagster
 *             as me — and to see the commit and the Dagster run id on the version, or the honest
 *             reason no run exists.
 * ARCHITECTURE:
 *   - Behind `DATA_PROJECT_GIT`. Order: await the hook's in-flight commits for the domain → read the
 *     head → compute the asset selection with the generator's own planner (`asset-keys.ts`) → wait
 *     (bounded) until Dagster's location exposes every key (repo-sync parses + reloads the location
 *     within ~15 s; a NEW model is unknown until then) → `launchRun` with the OS tags and the run-pod
 *     env `OS_PRINCIPAL` (the runner's principal) + `OS_PINNED_COMMITS` (so the run pod checks out
 *     this exact commit) → `setVersionRun({commit, dagsterRunId | launchError})`.
 *   - Sync retries re-use the failed run's `os/batch_id` so `delete+insert` re-covers the same slice
 *     (review L8); a first run mints one.
 *   - Every dependency is injectable; nothing here throws into a route — `launchDatasetBuild` is
 *     fire-and-forget and records the outcome on the dataset.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { log as gitLog } from '@core/infra/git-store';
import * as dagster from '@core/infra/dagster';
import type { Dataset, Layer } from '@tabs/data/lib/dataset-schema';
import { datasetForScheduler, setVersionRun } from '@tabs/data/lib/store';
import { dataProjectGitEnabled, awaitDataProjectCommits } from '@tabs/data/lib/dbt/commit';
import { projectSnapshot, type SnapshotDeps } from '@tabs/data/lib/dbt/snapshot';
import { datasetAssetKeys, selectionForBuild, selectionForSync } from '@tabs/data/lib/dbt/asset-keys';
import { syncLandingLayer } from '@tabs/data/lib/dbt/models';
import { reconcileSyncCron, type SyncCronOutcome } from '@tabs/data/lib/sync-cron';
import { runDatasetSync } from '@tabs/data/lib/sync-run-server';

export type LaunchKind = 'build' | 'sync';

export type LaunchInput = {
  datasetId: string;
  /** The layer that was built (build) or the sync landing (sync). */
  layer: Layer;
  kind: LaunchKind;
  /** The acting user (git author, `os/user`). */
  actor: { id: string };
  /** The Trino principal dbt impersonates: the caller's domain principal or the owner uid. */
  principal: string;
  /** `ui:<route>` | `mcp:<tool>` for the `os/surface` tag. */
  surface?: string;
  action: string;
  /** Sync "Reset & full re-sync" ⇒ `dbt build --full-refresh`. */
  fullRefresh?: boolean;
};

export type LaunchOutcome = {
  domain: string;
  commit: string | null;
  dagsterRunId: string | null;
  launchError: string | null;
  selection: string[][];
  /** The `os/batch_id` a sync run carries. */
  batchId?: string;
};

export type LaunchDeps = SnapshotDeps & {
  dagster?: Pick<typeof dagster, 'launchRun' | 'assetGraph' | 'runsForDataset'>;
  dataset?: (id: string) => Dataset | null;
  head?: (domain: string) => Promise<string | null>;
  awaitCommits?: () => Promise<void>;
  record?: typeof setVersionRun;
  reposDir?: string;
  waitMs?: number;
  pollMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

async function headOf(domain: string, reposDir?: string): Promise<string | null> {
  try {
    const entries = await gitLog(domain, { reposDir, limit: 1 });
    return entries[0]?.sha ?? null;
  } catch {
    return null;
  }
}

/** A deterministic batch id for a sync slice: `b_<dataset>_<yyyymmddHHMM>` (UTC). */
export function newBatchId(datasetId: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `b_${datasetId}_${stamp}`;
}

/** Re-use the newest FAILED run's batch id so a retry re-covers the same slice; else mint one. */
export async function batchIdForRetry(datasetId: string, runs: dagster.DagsterRun[], at: Date): Promise<string> {
  const newest = runs.find((r) => r.status === 'SUCCESS' || r.status === 'FAILURE' || r.status === 'CANCELED');
  if (newest && newest.status !== 'SUCCESS' && newest.tags['os/batch_id']) return newest.tags['os/batch_id'];
  return newBatchId(datasetId, at);
}

/** Wait (bounded) until the location exposes every key. Returns the keys still missing. */
export async function waitForAssets(keys: string[][], deps: LaunchDeps): Promise<{ missing: string[][]; error: string | null }> {
  const dg = deps.dagster ?? dagster;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? config.dagsterLaunchWaitMs;
  const pollMs = deps.pollMs ?? 5000;
  const want = new Set(keys.map((k) => k.join('/')));
  const started = Date.now();
  let lastError: string | null = null;
  for (;;) {
    const g = await dg.assetGraph();
    if (g.ok) {
      const have = new Set(g.data.map((n) => n.key.join('/')));
      const missing = [...want].filter((k) => !have.has(k));
      if (missing.length === 0) return { missing: [], error: null };
      lastError = `asset(s) not in the location yet: ${missing.join(', ')}`;
      if (Date.now() - started >= waitMs) return { missing: missing.map((k) => k.split('/')), error: lastError };
    } else {
      lastError = g.error;
      if (Date.now() - started >= waitMs) return { missing: keys, error: `Dagster unreachable: ${g.error}` };
    }
    await sleep(pollMs);
  }
}

/**
 * Commit-then-launch for one dataset. Records `{commit, dagsterRunId | launchError}` on the layer's
 * version and returns the outcome. Never throws.
 */
export async function launchAfterCommit(input: LaunchInput, deps: LaunchDeps = {}): Promise<LaunchOutcome> {
  const dg = deps.dagster ?? dagster;
  const getDs = deps.dataset ?? datasetForScheduler;
  const record = deps.record ?? setVersionRun;
  const now = deps.now ?? (() => new Date());
  await (deps.awaitCommits ?? awaitDataProjectCommits)();
  const d = getDs(input.datasetId);
  if (!d) return { domain: '', commit: null, dagsterRunId: null, launchError: 'dataset not found', selection: [] };
  if (!d.domain) {
    const launchError = 'dataset has no domain — no repository, nothing to launch';
    record(d.id, input.layer, { commit: null, dagsterRunId: null, launchError }, input.actor.id);
    return { domain: '', commit: null, dagsterRunId: null, launchError, selection: [] };
  }
  const commit = await (deps.head ?? ((dom) => headOf(dom, deps.reposDir)))(d.domain);
  const snapshot = await projectSnapshot(d.domain, deps);
  const keys = datasetAssetKeys(snapshot, d.id);
  const selection = input.kind === 'sync' ? selectionForSync(keys) : selectionForBuild(keys, input.layer);

  const finish = (dagsterRunId: string | null, launchError: string | null, batchId?: string): LaunchOutcome => {
    record(d.id, input.layer, { commit, dagsterRunId, launchError }, input.actor.id);
    return { domain: d.domain, commit, dagsterRunId, launchError, selection, ...(batchId ? { batchId } : {}) };
  };

  if (!commit) return finish(null, 'no commit on the domain repository yet (DATA_PROJECT_GIT on, nothing committed)');
  if (selection.length === 0) return finish(null, `no dbt model for ${input.layer} of this dataset (built out of band ⇒ a source, not launched)`);

  const ready = await waitForAssets(selection, deps);
  if (ready.error) return finish(null, `commit ${commit.slice(0, 7)} not launched: ${ready.error}`);

  const tags: Record<string, string> = {
    'os/dataset': d.id,
    'os/domain': d.domain,
    'os/principal': input.principal,
    'os/user': input.actor.id,
    'os/action': input.action,
    'os/layer': input.layer,
    'os/commit': commit,
    ...(input.surface ? { 'os/surface': input.surface } : {}),
    ...(input.fullRefresh ? { 'os/full_refresh': 'true' } : {}),
  };
  let batchId: string | undefined;
  if (input.kind === 'sync') {
    const prior = await dg.runsForDataset(d.id, 5);
    batchId = await batchIdForRetry(d.id, prior.ok ? prior.data : [], now());
    tags['os/batch_id'] = batchId;
  }
  const launched = await dg.launchRun({
    domain: d.domain,
    selection,
    tags,
    env: { OS_PRINCIPAL: input.principal, OS_PINNED_COMMITS: `${d.domain}=${commit}` },
  });
  if (!launched.ok) return finish(null, `commit ${commit.slice(0, 7)} not launched: ${launched.error}`, batchId);
  return finish(launched.data.runId, null, batchId);
}

/**
 * Fire-and-forget for the Build / transform / gold-join routes and MCP tools: when the flag is on,
 * launch after the commit and record the outcome on the version; a failure is logged, never
 * thrown into the request. Returns true when a launch was scheduled.
 */
export function launchDatasetBuild(input: Omit<LaunchInput, 'kind'>, deps: LaunchDeps = {}): boolean {
  if (!dataProjectGitEnabled()) return false;
  void launchAfterCommit({ ...input, kind: 'build' }, deps).catch((e) => {
    console.error(`[data-projects] launch failed for ${input.datasetId}/${input.layer}: ${e instanceof Error ? e.message : String(e)}`);
  });
  return true;
}

/* ------------------------------------------------- the scheduler hand-over -- */

/**
 * Reconcile a dataset's sync SCHEDULE. Flag off ⇒ the `batch/v1` CronJob, exactly as before.
 * Flag on ⇒ Dagster owns the schedule: it is declared in the domain repo's `os/schedules.yml`
 * (committed by the same write) and turned into a `ScheduleDefinition` by the `sovereign` code
 * location, so the OS provisions NO CronJob — and removes any CronJob a pre-B2 save left behind,
 * so the sync cannot fire twice. The outcome keeps the shape the panel and the MCP already render.
 */
export async function reconcileSyncSchedule(
  datasetId: string,
  sync: { enabled: boolean; schedule: { cron: string } } | null,
  deps: { flag?: () => boolean; cron?: typeof reconcileSyncCron } = {},
): Promise<SyncCronOutcome> {
  const cron = deps.cron ?? reconcileSyncCron;
  if (!(deps.flag ?? dataProjectGitEnabled)()) return cron(datasetId, sync);
  const removed = await cron(datasetId, null); // idempotent cleanup of a pre-B2 CronJob
  return {
    ok: true,
    live: removed.live,
    action: removed.action === 'deleted' ? 'deleted' : 'noop',
    name: removed.name,
    detail:
      `Dagster schedules this sync from the domain repository (os/schedules.yml, UTC) — no CronJob is provisioned.` +
      (removed.action === 'deleted' ? ` The pre-B2 CronJob ${removed.name} was removed.` : ''),
  };
}

/**
 * Run ONE sync now. Flag off ⇒ the OS executor and its `os-sync-runs` ledger row, unchanged.
 * Flag on ⇒ launch the dataset's assets in Dagster from the committed head as the dataset OWNER,
 * and write NO ledger row — the run IS the Dagster run (checklist D9). A retry re-uses the failed
 * run's `os/batch_id` so `delete+insert` re-covers exactly that slice.
 */
export async function runSyncNow(
  datasetId: string,
  trigger: 'manual' | 'reset' | 'schedule',
  actorId: string,
  deps: LaunchDeps & { flag?: () => boolean; action?: string } = {},
): Promise<
  | { mode: 'ledger'; outcome: Awaited<ReturnType<typeof runDatasetSync>> }
  | { mode: 'dagster'; launch: LaunchOutcome }
> {
  if (!(deps.flag ?? dataProjectGitEnabled)()) return { mode: 'ledger', outcome: await runDatasetSync(datasetId, trigger) };
  const d = (deps.dataset ?? datasetForScheduler)(datasetId);
  const launch = await launchAfterCommit(
    {
      datasetId,
      layer: d ? syncLandingLayer(d) : 'bronze',
      kind: 'sync',
      actor: { id: actorId },
      // Syncs run as the dataset OWNER — the same principal the ledger executor resolved.
      principal: d?.owner ?? actorId,
      action: deps.action ?? (trigger === 'schedule' ? 'scheduled sync' : trigger === 'reset' ? 'reset and full re-sync' : 'sync now'),
      fullRefresh: trigger === 'reset',
    },
    deps,
  );
  return { mode: 'dagster', launch };
}
