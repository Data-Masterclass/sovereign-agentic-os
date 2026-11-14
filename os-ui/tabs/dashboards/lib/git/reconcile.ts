/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The boot reconcile — the repository becomes TRUE without anyone re-saving anything
 * USER STORY: As a domain admin I want the dashboards in my repository to match the OS after a
 *             boot with the git flag newly on, or after a crash between a store write and its
 *             commit — without opening and re-saving every dashboard by hand (H-4).
 * ARCHITECTURE:
 *   - The exact shape `tabs/agents/lib/git/reconcile.ts` took, and for the same reasons. The commit
 *     hook only sees writes from NOW on, so the FIRST boot with `DATA_PROJECT_GIT` on — and any
 *     boot after a crash between a store write and its commit — must commit the difference.
 *   - IT WILL NOT RUN ON AN UNVERIFIED REGISTRY. `ensureHydrated()` RESOLVES when the durable
 *     mirror was unreachable (it records the failure for a later retry and does not throw). A
 *     reconcile that trusted that would generate `dashboards: []` for every domain and
 *     `commitSubtree` an empty map, which DELETES every dashboard directory in every domain that
 *     has one — and then pushes that to the configured mirror. So `hydrationState()` is consulted
 *     first and anything but `'hydrated'` SKIPS, loudly. An empty registry we could not verify is
 *     not a reason to delete anything.
 *   - SECOND LINE OF DEFENCE: the git store's own `DestructiveReconcileError` still applies — an
 *     `OS-Reason: boot-reconcile` commit that would delete more than half the files it tracks while
 *     adding none is refused by `commitSubtree` itself. This module does not weaken it to make a
 *     reconcile pass; a refusal is reported as the outcome's `error`.
 *   - Attributed to the PLATFORM, not to a person: nobody performed this action, so the commit
 *     carries `OS-Surface: boot:reconcile` and `OS-Reason: boot-reconcile` rather than borrowing
 *     the last writer's name.
 *   - Targets = every domain holding a dashboard, PLUS every existing repository that already
 *     carries a `dashboards/` subtree (so a domain whose last dashboard was deleted while the flag
 *     was off still gets the deletion committed). An unreadable repo is skipped, never guessed at.
 *   - Never throws into boot: `reconcileDashboardsAtBoot` logs one line and returns.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { listRepos, listTree } from '@core/infra/git-store';
import {
  commitDashboards,
  dashboardProjectGitEnabled,
  type CommitDeps,
} from '@tabs/dashboards/lib/git/commit';
import { DASHBOARDS_PREFIX } from '@tabs/dashboards/lib/git/generate';
import { dashboardDomains, dashboardsForProject, hydrationState } from '@tabs/dashboards/lib/store';

/** The surface and reason a reconcile commit carries — it is a catch-up, not a person's action. */
export const RECONCILE_SURFACE = 'boot:reconcile';
export const RECONCILE_REASON = 'boot-reconcile';

/** The platform principal a reconcile is authored as. Never a real user. */
export const PLATFORM_ACTOR = { id: 'system', name: 'Sovereign OS', email: 'os@sovereign.local' };

export type ReconcileOutcome = { domain: string; changed: boolean; sha?: string; error?: string };

export type ReconcileDeps = CommitDeps & {
  /** Domains holding live dashboards (default: the store). */
  domains?: () => string[];
  /** Existing repositories (default: the git store's PVC listing). */
  repos?: () => Promise<{ name: string }[]>;
  /** Does this repo already carry a `dashboards/` subtree? (default: the git store's tree read). */
  hasDashboardsSubtree?: (domain: string) => Promise<boolean>;
  /** Did the registry really load? (default: the store's own probe). */
  hydration?: () => 'hydrated' | 'failed' | 'pending';
  /** The per-domain snapshot read (default: the store's own, which resolves lifecycle pins). */
  capture?: (domain: string) => Promise<ReturnType<typeof dashboardsForProject>> | ReturnType<typeof dashboardsForProject>;
};

/**
 * Reconcile every relevant domain. Returns one outcome per domain attempted (a no-op domain is
 * reported with `changed: false`, which is the honest answer and what the test asserts).
 */
export async function reconcileDashboardProjects(deps: ReconcileDeps = {}): Promise<ReconcileOutcome[]> {
  if (!dashboardProjectGitEnabled()) return [];

  const hydration = (deps.hydration ?? hydrationState)();
  if (hydration !== 'hydrated') {
    console.error(
      `[dashboard-projects] boot reconcile SKIPPED — the dashboard registry is '${hydration}', not 'hydrated': the durable ` +
        'mirror could not be read, so an empty store would be indistinguishable from a tenant with no ' +
        'dashboards. Nothing was committed. It runs on the next boot, or the next save commits by itself.',
    );
    return [];
  }

  const reposDir = deps.reposDir ?? config.reposDir;
  const withDashboards = (deps.domains ?? dashboardDomains)();
  const repos = await (deps.repos ?? (() => listRepos({ reposDir })))();
  const hasSubtree =
    deps.hasDashboardsSubtree ??
    (async (domain: string) => (await listTree(domain, 'main', { reposDir })).some((e) => e.path.startsWith(DASHBOARDS_PREFIX)));

  const targets = new Set(withDashboards);
  for (const r of repos) {
    if (targets.has(r.name)) continue;
    try {
      // A domain whose last dashboard was deleted while the flag was off still needs the deletion
      // committed, so a repo that already carries the subtree is a target even with no dashboards.
      if (await hasSubtree(r.name)) targets.add(r.name);
    } catch {
      /* an unreadable repo is skipped, not guessed about */
    }
  }

  const capture = deps.capture ?? ((domain: string) => dashboardsForProject(domain));
  const out: ReconcileOutcome[] = [];
  for (const domain of [...targets].sort()) {
    try {
      const captured = await capture(domain);
      const result = await commitDashboards(
        domain,
        PLATFORM_ACTOR,
        { action: 'reconcile dashboards', object: domain, objectId: domain, surface: RECONCILE_SURFACE, reason: RECONCILE_REASON },
        { ...deps, reposDir, captured },
      );
      out.push({ domain, changed: !!result?.changed, ...(result?.sha ? { sha: result.sha } : {}) });
    } catch (e) {
      // Includes the git store's `DestructiveReconcileError`: reported, never worked around.
      out.push({ domain, changed: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Boot entry point: reconcile and log one line. Never throws, never delays boot by failing. */
export async function reconcileDashboardsAtBoot(deps: ReconcileDeps = {}): Promise<void> {
  try {
    const outcomes = await reconcileDashboardProjects(deps);
    const changed = outcomes.filter((o) => o.changed).map((o) => o.domain);
    const failed = outcomes.filter((o) => o.error);
    if (changed.length > 0) console.info(`[dashboard-projects] boot reconcile committed: ${changed.join(', ')}`);
    for (const f of failed) console.error(`[dashboard-projects] boot reconcile failed for ${f.domain}: ${f.error}`);
    if (changed.length === 0 && failed.length === 0) {
      console.info(`[dashboard-projects] boot reconcile: ${outcomes.length} domain(s) already up to date`);
    }
  } catch (e) {
    console.error(`[dashboard-projects] boot reconcile errored: ${e instanceof Error ? e.message : String(e)}`);
  }
}
