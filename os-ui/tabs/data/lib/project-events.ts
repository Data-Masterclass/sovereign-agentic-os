/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Project-change events — the one seam every dataset write passes through
 * USER STORY: As a maintainer I want every mutation of a dataset, composition, check, sync,
 *             publish or retire to announce itself once, so the git commit hook (and any later
 *             listener) can act without each writer knowing about git.
 * ARCHITECTURE:
 *   - Pure, synchronous, dependency-free. The store (`store.ts`, reachable from the CLIENT bundle
 *     through `lib/index.ts`) may not import node:fs or isomorphic-git — so it emits here and the
 *     server-only commit hook (`dbt/commit.ts`) subscribes at boot. Listeners run in the caller's
 *     async context, so the request surface (core/infra/request-surface) is readable inside them.
 *   - A throwing listener is logged and never fails the write (the write already happened).
 *   - Listeners live on globalThis (survive HMR) like the store itself.
 */

export type ProjectChange = {
  /** The owning domain whose repo changes (`''` for an unassigned dataset — no repo). */
  domain: string;
  datasetId: string;
  /** Short imperative label (`build gold`, `add check`, `configure sync`, `promote`, `retire`). */
  action: string;
  /** The acting principal's id (`system` for propagation sweeps with no session). */
  actorId: string;
};

export type ProjectChangeListener = (change: ProjectChange) => void;

const KEY = Symbol.for('soa.data.project-events');
function listeners(): Set<ProjectChangeListener> {
  const g = globalThis as unknown as Record<symbol, Set<ProjectChangeListener> | undefined>;
  if (!g[KEY]) g[KEY] = new Set();
  return g[KEY]!;
}

/** Subscribe; returns the unsubscribe function. */
export function onProjectChange(listener: ProjectChangeListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

/** Announce a change. Synchronous fan-out; a listener's throw is logged, never propagated. */
export function emitProjectChange(change: ProjectChange): void {
  for (const l of [...listeners()]) {
    try {
      l(change);
    } catch (e) {
      console.error(`[data-projects] change listener failed for ${change.action} on ${change.datasetId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Test hook: drop every listener. */
export function __resetProjectListeners(): void {
  listeners().clear();
}
