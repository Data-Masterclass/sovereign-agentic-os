/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Boot-time reconcile — the repository catches up with the registry at startup
 *             (engine rebuild B4; closes the B2 review's "crash gap between store write and commit")
 * USER STORY: As an operator I want the FIRST boot with `DATA_PROJECT_GIT` on to commit every
 *             dataset that already exists, and every later boot to commit whatever a crash between
 *             a store write and its commit left behind — so the domain repository is never quietly
 *             behind what the OS says is true.
 * ARCHITECTURE:
 *   - For every domain the OS knows (datasets in the store ∪ repositories on disk — a domain whose
 *     last dataset was deleted still needs its project emptied), regenerate the project and commit
 *     the delta through the ONE commit path (`commitDataProject`, which commits iff the tree hash
 *     moved). A boot that changed nothing commits nothing.
 *   - The author is the PLATFORM principal (`Sovereign OS`), not a user — no person performed this
 *     write — and the commit carries `OS-Reason: boot-reconcile` so the history distinguishes a
 *     catch-up from an action.
 *   - Fail-soft per domain and never throwing: one unreadable repository must not stop the others
 *     or the boot. The result is returned for the boot log.
 *   - IT WILL NOT RUN ON AN UNVERIFIED REGISTRY (Part D review H-1): `hydrationState()` must say
 *     `hydrated`. A store that hydrated empty because OpenSearch was not up yet looks exactly like
 *     a domain with no datasets, and this writer's answer to "no datasets" is to delete the models.
 *     The git store's destructive-delta guard is the second, independent line of defence.
 *   - IT STANDS DOWN THE PRE-B2 SCHEDULER FIRST (B4-review H-1). The first commit of
 *     `os/schedules.yml` makes Dagster the scheduler for every synced dataset, but a pre-B2 install
 *     still has one `batch/v1` CronJob per synced dataset curling the old executor — and nothing
 *     else deletes it until that dataset's sync is saved again. For the window in between, one
 *     slice fires twice. So before the FIRST commit this reconcile calls `removeSyncCronJob` for
 *     every dataset with a sync: idempotent (a 404 is the normal answer), fail-soft (a 403 from a
 *     cluster whose Role has no `batch` grant is logged, never thrown — the boot must not die for
 *     a cleanup) and logged per dataset so an operator can see what was stood down.
 *   - It does NOT launch Dagster: the code location's repo-sync picks the new commit up on its own
 *     cadence, and a boot must not start work nobody asked for.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { COMMITTER, listRepos } from '@core/infra/git-store';
import { ensureHydrated, hydrationState, listAllDatasets } from '@tabs/data/lib/store';
import { commitDataProject, dataProjectGitEnabled, type ActorIdentity, type HookDeps } from '@tabs/data/lib/dbt/commit';
import { removeSyncCronJob } from '@tabs/data/lib/sync-cron-removal';

/** The platform principal: author AND committer for a write no person performed. */
export const PLATFORM_ACTOR: ActorIdentity = { id: 'system', name: COMMITTER.name, email: COMMITTER.email };

export const BOOT_REASON = 'boot-reconcile';

export type BootReconcileResult = {
  /** Domains examined. */
  domains: string[];
  /** Domains whose tree had moved, with the commit that fixed it. */
  committed: { domain: string; sha: string }[];
  /** Domains that could not be reconciled, with the honest reason. */
  failed: { domain: string; error: string }[];
  /** False when `DATA_PROJECT_GIT` is off — nothing was examined and nothing claimed. */
  ran: boolean;
  /** Pre-B2 sync CronJobs stood down before the first commit (B4-review H-1), one entry per
   *  synced dataset examined — `removed` only where a cluster CONFIRMED the deletion. */
  cronsStoodDown: { datasetId: string; removed: boolean; detail: string }[];
};

export type BootReconcileDeps = HookDeps & {
  /** Override the domain discovery (tests). */
  domains?: () => Promise<string[]>;
  hydrate?: () => Promise<unknown>;
  /** Did the registry really load? (default: the store's own probe). Review H-1. */
  hydration?: () => 'hydrated' | 'failed' | 'pending';
  /** The pre-B2 CronJob cleanup (tests inject a fake k8s client). B4-review H-1. */
  cron?: typeof removeSyncCronJob;
};

/** Datasets in the store ∪ repositories on disk, sorted — deterministic for the log and the tests. */
async function discoverDomains(deps: BootReconcileDeps): Promise<string[]> {
  if (deps.domains) return (await deps.domains()).slice().sort();
  const fromStore = listAllDatasets()
    .map((d) => d.domain)
    .filter((d): d is string => Boolean(d));
  let fromDisk: string[] = [];
  try {
    fromDisk = (await listRepos({ reposDir: deps.reposDir ?? config.reposDir })).map((r) => r.name);
  } catch {
    fromDisk = []; // no repos directory yet (first boot) — the store is the whole truth
  }
  return [...new Set([...fromStore, ...fromDisk])].sort();
}

/**
 * Delete the pre-B2 `batch/v1` CronJob of every dataset that has a sync, BEFORE the first commit
 * of `os/schedules.yml` hands the same schedule to Dagster. Idempotent, fail-soft, logged per
 * dataset — a cluster that refuses (403: no `batch` grant) or cannot be reached is reported, never
 * raised: a cleanup must not stop a boot. B4-review H-1.
 */
async function standDownPreB2Crons(deps: BootReconcileDeps): Promise<BootReconcileResult['cronsStoodDown']> {
  const remove = deps.cron ?? removeSyncCronJob;
  const synced = listAllDatasets().filter((d) => d.sync);
  const out: BootReconcileResult['cronsStoodDown'] = [];
  for (const d of synced) {
    let outcome: Awaited<ReturnType<typeof removeSyncCronJob>>;
    try {
      outcome = await remove(d.id);
    } catch (e) {
      // `removeSyncCronJob` documents "never throws"; a client that breaks that promise still may
      // not take the boot down with it.
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`[data-projects] boot reconcile: could not stand down the pre-B2 sync CronJob for ${d.id}: ${detail}`);
      out.push({ datasetId: d.id, removed: false, detail });
      continue;
    }
    const removed = outcome.action === 'deleted' && outcome.live;
    if (removed) {
      console.log(`[data-projects] boot reconcile: stood down the pre-B2 sync CronJob for ${d.id} — ${outcome.detail}`);
    } else if (!outcome.ok) {
      console.error(
        `[data-projects] boot reconcile: the pre-B2 sync CronJob for ${d.id} was NOT confirmed gone — ${outcome.detail} ` +
          'Dagster now schedules this sync from the repository, so the slice may fire twice until the CronJob is removed.',
      );
    }
    out.push({ datasetId: d.id, removed, detail: outcome.detail });
  }
  return out;
}

/**
 * Commit, for every domain, the difference between the generated project and the repository HEAD.
 * Returns what it found; never throws.
 */
export async function reconcileDataProjectsAtBoot(deps: BootReconcileDeps = {}): Promise<BootReconcileResult> {
  if (!dataProjectGitEnabled()) return { domains: [], committed: [], failed: [], ran: false, cronsStoodDown: [] };
  try {
    await (deps.hydrate ?? ensureHydrated)();
  } catch {
    /* the throw is not the signal — `hydrationState()` below is (it resolves either way) */
  }
  // HYDRATION GATE (Part D review H-1). The reconcile is a WHOLE-TREE writer: with an empty
  // registry it generates a bare project and commits the DELETION of every model in the domain,
  // then pushes it to the mirror. `ensureHydrated()` resolves even when the mirror was
  // unreachable, so "no datasets" and "we could not read the datasets" arrive identically — and
  // the Sept-2026 login outage proved that race happens at boot. Only a verified read may delete.
  const hydration = (deps.hydration ?? hydrationState)();
  if (hydration !== 'hydrated') {
    console.error(
      `[data-projects] boot reconcile SKIPPED — the dataset registry is '${hydration}', not 'hydrated': the durable mirror ` +
        'could not be read, so an empty store would be indistinguishable from a domain with no datasets. ' +
        'Nothing was committed. It runs on the next boot, or the next dataset write commits by itself.',
    );
    return { domains: [], committed: [], failed: [], ran: false, cronsStoodDown: [] };
  }
  // BEFORE the first commit: the old scheduler is stood down, so `os/schedules.yml` never races a
  // surviving CronJob for the same slice (B4-review H-1).
  const cronsStoodDown = await standDownPreB2Crons(deps);
  const domains = await discoverDomains(deps);
  const committed: { domain: string; sha: string }[] = [];
  const failed: { domain: string; error: string }[] = [];
  for (const domain of domains) {
    try {
      const result = await commitDataProject(
        domain,
        PLATFORM_ACTOR,
        {
          action: 'reconcile project',
          object: domain,
          objectId: domain,
          surface: `system:${BOOT_REASON}`,
          extraTrailers: { 'OS-Reason': BOOT_REASON },
        },
        deps,
      );
      if (result?.changed) committed.push({ domain, sha: result.sha });
    } catch (e) {
      failed.push({ domain, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { domains, committed, failed, ran: true, cronsStoodDown };
}
