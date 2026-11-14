/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    Dashboard-change events — the one seam every dashboard write passes through
 * USER STORY: As a maintainer I want every mutation of a dashboard (save, rename, promote, demote,
 *             archive, move, restore, delete) to announce itself once, so the git commit hook can
 *             act without any writer knowing about git (D8, D-R3.1).
 * ARCHITECTURE:
 *   - Pure, synchronous, dependency-free — the exact shape `tabs/agents/lib/system-events.ts` and
 *     `tabs/data/lib/project-events.ts` took. One pattern for all three halves.
 *   - `lib/store.ts` is reachable from the CLIENT bundle through `lib/index.ts`, so it may not
 *     import node:fs or isomorphic-git: it emits here, and the server-only `lib/git/commit.ts`
 *     subscribes at boot.
 *   - Listeners run in the caller's async context, so the ambient request surface
 *     (`core/infra/request-surface`) is readable inside them — that is how a commit learns whether
 *     it came from `ui:<route>` or `mcp:<tool>`.
 *   - A throwing listener is logged and never fails the write: the write already happened, and
 *     losing it to a git hiccup would be worse than a missing commit.
 *   - Listeners live on globalThis (survive HMR) like the store itself.
 */

export type DashboardChange = {
  /** The owning domain whose repo changes (`''` ⇒ no repo, so nothing is committed). */
  domain: string;
  dashboardId: string;
  /** Display name at the time of the write (for the commit subject). */
  name: string;
  /** Short imperative label (`create dashboard`, `rename`, `promote to Domain`, …). */
  action: string;
  /** The acting principal's id (`system` for an admin sweep with no session). */
  actorId: string;
  /** Set when the write MOVED the dashboard between domains — both repos must be committed. */
  previousDomain?: string;
};

export type DashboardChangeListener = (change: DashboardChange) => void;

const KEY = Symbol.for('soa.dashboards.change-events');
function listeners(): Set<DashboardChangeListener> {
  const g = globalThis as unknown as Record<symbol, Set<DashboardChangeListener> | undefined>;
  if (!g[KEY]) g[KEY] = new Set();
  return g[KEY]!;
}

/** Subscribe; returns the unsubscribe function. */
export function onDashboardChange(listener: DashboardChangeListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

/** Announce a change. Synchronous fan-out; a listener's throw is logged, never propagated. */
export function emitDashboardChange(change: DashboardChange): void {
  for (const l of [...listeners()]) {
    try {
      l(change);
    } catch (e) {
      console.error(
        `[dashboard-projects] change listener failed for ${change.action} on ${change.dashboardId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** Test hook: drop every listener. */
export function __resetDashboardListeners(): void {
  listeners().clear();
}
