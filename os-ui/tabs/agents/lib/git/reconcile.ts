/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Boot reconcile — the repo catches up with whatever happened while git was off
 * USER STORY: As a platform admin I want the domain repositories to be TRUE after a restart, a
 *             mirror-down window or a period with `DATA_PROJECT_GIT` off, without anyone having
 *             to re-save every agent system: at boot the OS diffs what it would generate against
 *             the repo and commits the delta as the platform principal, saying why.
 * ARCHITECTURE:
 *   - `commitAgentSystem` already commits IFF the subtree hash changed, so reconcile is simply
 *     "generate once per domain and let the store decide" — no hand-rolled diff to drift.
 *   - The actor is the PLATFORM principal (author = committer = `Sovereign OS`), with
 *     `OS-Reason: boot-reconcile` and `OS-Surface: boot:reconcile`, so a reconcile commit is never
 *     mistaken for a user's save.
 *   - PER-OBJECT ATTRIBUTION (X-R1). The commit is one commit for the whole subtree, so its
 *     `OS-Object` is the DOMAIN and no system's history used to find it: every system that existed
 *     before git was switched on reported `git.head: null` — "never committed" — about a system
 *     that is in the repository. `allObjects: true` makes the commit list every system it carried
 *     in an `OS-Objects` trailer, which `systemGitInfo` now reads. (The generic path-based
 *     fallback is stream G's, G-R2.1; either alone fixes the symptom, and this one also makes the
 *     reconcile commit honest about what it touched.)
 *   - WHICH domains: every domain that holds a live system, plus every existing repo that already
 *     carries an `agents/` subtree (so a domain whose last system was deleted while git was off
 *     gets the REMOVAL committed). A data-only repo is left untouched — reconcile never creates an
 *     `agents/` directory in a domain that has never had one.
 *   - Fail-soft per domain: one unreachable repo never stops the others, and nothing throws into
 *     boot. Deps are injected so the whole thing is unit-testable with a temp dir or a spy.
 *   - IT WILL NOT RUN ON AN UNVERIFIED REGISTRY (review H-1): the store's `hydrationState()` must
 *     say `hydrated`. A store that hydrated EMPTY because the mirror was down looks exactly like a
 *     tenant that owns nothing, and reconcile's answer to "nothing" is to delete everything. The
 *     git store's destructive-delta guard is the second, independent line of defence.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { listRepos, listTree } from '@core/infra/git-store';
import { projectDomains, hydrationState } from '@tabs/agents/lib/store';
import { AGENTS_PREFIX } from '@tabs/agents/lib/git/generate';
import { agentProjectGitEnabled, commitAgentSystem, type CommitDeps } from '@tabs/agents/lib/git/commit';

/** The platform principal a reconcile commit is authored as. */
export const PLATFORM_ACTOR = { id: 'sovereign-os', name: 'Sovereign OS', email: 'os@sovereign.local' } as const;
export const RECONCILE_SURFACE = 'boot:reconcile';
export const RECONCILE_REASON = 'boot-reconcile';

export type ReconcileOutcome = { domain: string; changed: boolean; sha?: string; error?: string };

export type ReconcileDeps = CommitDeps & {
  /** Domains holding live systems (default: the store). */
  domains?: () => string[];
  /** Existing repositories (default: the git store's PVC listing). */
  repos?: () => Promise<{ name: string }[]>;
  /** Does this repo already carry an `agents/` subtree? (default: the git store's tree read). */
  hasAgentsSubtree?: (domain: string) => Promise<boolean>;
  /** Did the registry really load? (default: the store's own probe). Review H-1. */
  hydration?: () => 'hydrated' | 'failed' | 'pending';
};

/**
 * Reconcile every relevant domain. Returns one outcome per domain attempted (a no-op domain is
 * reported with `changed: false`, which is the honest answer and what the test asserts).
 */
export async function reconcileAgentProjects(deps: ReconcileDeps = {}): Promise<ReconcileOutcome[]> {
  if (!agentProjectGitEnabled()) return [];
  // HYDRATION GATE (review H-1). `ensureHydrated()` RESOLVES when the mirror was unreachable —
  // it records the failure for the throttled retry and does not throw. A reconcile that trusted
  // that would generate `systems: []` for every domain and `commitSubtree` an empty map, which
  // DELETES every system directory in every domain that has one, and then pushes that to the
  // mirror. An empty registry we could not verify is not a reason to delete anything.
  const hydration = (deps.hydration ?? hydrationState)();
  if (hydration !== 'hydrated') {
    console.error(
      `[agent-projects] boot reconcile SKIPPED — the system registry is '${hydration}', not 'hydrated': the durable mirror ` +
        'could not be read, so an empty store would be indistinguishable from a tenant with no systems. ' +
        'Nothing was committed. It runs on the next boot, or the next save commits by itself.',
    );
    return [];
  }
  const reposDir = deps.reposDir ?? config.reposDir;
  const withSystems = (deps.domains ?? projectDomains)();
  const repos = await (deps.repos ?? (() => listRepos({ reposDir })))();
  const hasSubtree =
    deps.hasAgentsSubtree ??
    (async (domain: string) => (await listTree(domain, 'main', { reposDir })).some((e) => e.path.startsWith(AGENTS_PREFIX)));
  const targets = new Set(withSystems);
  for (const r of repos) {
    if (targets.has(r.name)) continue;
    try {
      if (await hasSubtree(r.name)) targets.add(r.name);
    } catch {
      /* an unreadable repo is skipped, not guessed about */
    }
  }
  const out: ReconcileOutcome[] = [];
  for (const domain of [...targets].sort()) {
    try {
      const result = await commitAgentSystem(
        domain,
        PLATFORM_ACTOR,
        {
          action: 'reconcile agent systems',
          object: domain,
          objectId: domain,
          surface: RECONCILE_SURFACE,
          reason: RECONCILE_REASON,
          allObjects: true, // X-R1
        },
        { ...deps, reposDir },
      );
      out.push({ domain, changed: !!result?.changed, ...(result?.sha ? { sha: result.sha } : {}) });
    } catch (e) {
      out.push({ domain, changed: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Boot entry point: reconcile and log one line. Never throws, never delays boot by failing. */
export async function reconcileAgentProjectsAtBoot(deps: ReconcileDeps = {}): Promise<void> {
  try {
    const outcomes = await reconcileAgentProjects(deps);
    const changed = outcomes.filter((o) => o.changed).map((o) => o.domain);
    const failed = outcomes.filter((o) => o.error);
    if (changed.length > 0) console.info(`[agent-projects] boot reconcile committed: ${changed.join(', ')}`);
    for (const f of failed) console.error(`[agent-projects] boot reconcile failed for ${f.domain}: ${f.error}`);
    if (changed.length === 0 && failed.length === 0) console.info(`[agent-projects] boot reconcile: ${outcomes.length} domain(s) already up to date`);
  } catch (e) {
    console.error(`[agent-projects] boot reconcile errored: ${e instanceof Error ? e.message : String(e)}`);
  }
}
