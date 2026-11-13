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
 *   - It does NOT launch Dagster: the code location's repo-sync picks the new commit up on its own
 *     cadence, and a boot must not start work nobody asked for.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { COMMITTER, listRepos } from '@core/infra/git-store';
import { ensureHydrated, listAllDatasets } from '@tabs/data/lib/store';
import { commitDataProject, dataProjectGitEnabled, type ActorIdentity, type HookDeps } from '@tabs/data/lib/dbt/commit';

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
};

export type BootReconcileDeps = HookDeps & {
  /** Override the domain discovery (tests). */
  domains?: () => Promise<string[]>;
  hydrate?: () => Promise<unknown>;
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
 * Commit, for every domain, the difference between the generated project and the repository HEAD.
 * Returns what it found; never throws.
 */
export async function reconcileDataProjectsAtBoot(deps: BootReconcileDeps = {}): Promise<BootReconcileResult> {
  if (!dataProjectGitEnabled()) return { domains: [], committed: [], failed: [], ran: false };
  try {
    await (deps.hydrate ?? ensureHydrated)();
  } catch {
    /* an unreachable mirror is not a reason to skip the repositories we can see */
  }
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
  return { domains, committed, failed, ran: true };
}
