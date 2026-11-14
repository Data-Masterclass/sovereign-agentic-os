/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    This tab's `GitObjectResolver` — "here is how to find THIS dashboard in the repo"
 * USER STORY: As a user I want a dashboard's head commit, history and diff in the UI and over the
 *             MCP, resolved the same way for every object kind (D24, stream G's `objectGitInfo`).
 * ARCHITECTURE:
 *   - THE CONTRACT FOR STREAM G. G owns `core/infra/git-objects.ts` (the registry, the generic
 *     `objectGitInfo` / `getVersion` / `diffVersions` reads and the `<GitHeadBadge/>` component);
 *     each tab registers how to LOCATE its own object. This is the dashboards registration.
 *   - The resolver is declared against G's `GitObjectLocation` shape rather than importing it:
 *     `core/infra/git-objects.ts` is not in this stream's worktree, and a tab may not import a
 *     module that does not compile. The local type is a copy of G's, kept deliberately minimal;
 *     the merge deletes it and imports the real one (see the stream's deviation D-4 for the exact
 *     three-line patch, which is `import { registerGitObject } …` + the call + the kinds-row flip).
 *   - VISIBILITY IS THE STORE'S, NOT OURS: it resolves through `getDashboard(id, user)`, so a
 *     dashboard the caller cannot see is indistinguishable from one that does not exist — the OS's
 *     `not_found` convention (G5). This module adds no second visibility rule.
 *   - PATHS, NOT CONTENT: the resolver says WHERE the object lives, so G's path-based
 *     `git log -- <path>` fallback works even for commits that carry platform attribution rather
 *     than a per-object `OS-Object` trailer (the night-1 defect that made `git.head` null).
 *   - A dashboard publishes no releases, so there is no `tagPrefix`.
 */
import type { Role } from '@core/kernel/session';
import { getDashboard } from '@tabs/dashboards/lib/store';
import { pathsForDashboard } from '@tabs/dashboards/lib/git/facts';
import type { StoredDashboard } from '@tabs/dashboards/lib/git/snapshot';

/** G's `GitObjectLocation`, copied verbatim in shape (see ARCHITECTURE). */
export type GitObjectLocation = {
  /** The domain whose repo holds it. */
  domain: string;
  /** Repo path selectors: `a/b/` for everything under, `a/b.yml` for one file. */
  paths: string[];
  /** The id as the `OS-Object` trailer carries it (defaults to the object id). */
  trailerId?: string;
  /** A display name for the drawer header. */
  name?: string;
};

/** The caller, narrowed to what the lookup needs (G passes its `CurrentUser`). */
export type GitObjectUser = { id: string; domains: string[]; role: Role };

/** The kind string this tab registers under, in G's `GIT_OBJECT_KINDS`. */
export const GIT_OBJECT_KIND = 'dashboard';

/**
 * The repo paths that make up one dashboard: its own directory, plus the shared index, which is
 * regenerated on every change and is therefore part of this object's history.
 *
 * H-3: the directory is slugged from the dashboard's NAME, so **slug ≠ id** and a caller that
 * guessed `dashboards/<id>/` would be wrong for essentially every dashboard. `lib/git/facts.ts`
 * `pathsForDashboard` resolves it through the committed `dashboards/index.yml` when it can be read
 * and recomputes the placement otherwise — this is the thin wrapper over it, kept for the two
 * callers that already have the record in hand.
 */
export function dashboardPaths(dir: string): string[] {
  return [`${dir.replace(/\/+$/, '')}/`, 'dashboards/index.yml'];
}

/**
 * Locate one dashboard in its domain's repository, or `null` when the caller cannot see it (which
 * is deliberately the same answer as "it does not exist").
 *
 * `read` is injected so this stays pure and testable: the real registration passes the store's
 * own `getDashboard`, which applies the visibility gate and throws for a dashboard the caller may
 * not view.
 */
export function resolveDashboardGitObject(
  user: GitObjectUser,
  id: string,
  read: (id: string, user: GitObjectUser) => StoredDashboard | null,
  /** The committed `dashboards/index.yml`, when the caller has read it. Preferred over the record. */
  indexYaml?: string | null,
): GitObjectLocation | null {
  let rec: StoredDashboard | null = null;
  try {
    rec = read(id, user);
  } catch {
    // The store throws 403/404 for an invisible or missing dashboard; both are `null` here, so
    // the generic read cannot be used to probe for the existence of someone else's dashboard.
    return null;
  }
  if (!rec || !rec.domain) return null;
  // Resolved through facts.ts, which prefers the committed index (slug ≠ id — H-3) and falls back
  // to recomputing the placement from the record. `indexYaml` is absent here because this resolver
  // is called without a repository read; G passes one when it has it.
  const paths = pathsForDashboard(id, { record: rec, indexYaml: indexYaml ?? null });
  if (!paths) return null;
  return {
    domain: rec.domain,
    paths,
    // The commit path writes `OS-Object: <id> (<name>)`, and G matches on the id prefix.
    trailerId: rec.id,
    name: rec.spec.name,
  };
}

/**
 * The resolver stream G registers. Wired by the merge as:
 *
 * ```ts
 * import { registerGitObject } from '@core/infra/git-objects';
 * import { dashboardGitObjectResolver } from '@tabs/dashboards/lib/git/git-object';
 * registerGitObject('dashboard', dashboardGitObjectResolver);
 * ```
 *
 * It reads through the store's own visibility gate, so there is no second rule to keep in step.
 */
export function dashboardGitObjectResolver(user: GitObjectUser, id: string): GitObjectLocation | null {
  return resolveDashboardGitObject(user, id, (dashboardId, principal) => getDashboard(dashboardId, principal));
}
