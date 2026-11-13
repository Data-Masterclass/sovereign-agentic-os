/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    System-change events — the one seam every agent-system write passes through
 * USER STORY: As a maintainer I want every mutation of an agent system (create, edit, grant
 *             change, build, promote, rename, move, archive, delete, restore) to announce itself
 *             once, so the git commit hook can act without any writer knowing about git.
 * ARCHITECTURE:
 *   - Pure, synchronous, dependency-free — the exact shape `tabs/data/lib/project-events.ts`
 *     took for the data side (Part D keeps ONE pattern for both halves). `store.ts` is reachable
 *     from the CLIENT bundle through `lib/index.ts`, so it may not import node:fs or
 *     isomorphic-git: it emits here, and the server-only `lib/git/commit.ts` subscribes at boot.
 *   - Listeners run in the caller's async context, so the ambient request surface
 *     (`core/infra/request-surface`) is readable inside them.
 *   - A throwing listener is logged and never fails the write — the write already happened.
 *   - Listeners live on globalThis (survive HMR) like the store itself.
 *   - RUNS DO NOT EMIT. A run's artefacts are the LangGraph checkpoint, the `run_events` rows,
 *     the Langfuse trace and the Dagster/LiteLLM meters — none of them belong in the definition
 *     repo, and committing per node would bury every real change under run noise.
 */

export type SystemChange = {
  /** The owning domain whose repo changes (`''` for an unassigned system — no repo). */
  domain: string;
  systemId: string;
  /** Display name at the time of the write (for the commit subject). */
  name: string;
  /** Short imperative label (`create system`, `edit system.yaml`, `promote to Shared`, …). */
  action: string;
  /** The acting principal's id (`system` for an admin sweep with no session). */
  actorId: string;
  /** Set when the write MOVED the system between domains — both repos must be committed. */
  previousDomain?: string;
};

export type SystemChangeListener = (change: SystemChange) => void;

const KEY = Symbol.for('soa.agents.system-events');
function listeners(): Set<SystemChangeListener> {
  const g = globalThis as unknown as Record<symbol, Set<SystemChangeListener> | undefined>;
  if (!g[KEY]) g[KEY] = new Set();
  return g[KEY]!;
}

/** Subscribe; returns the unsubscribe function. */
export function onSystemChange(listener: SystemChangeListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

/** Announce a change. Synchronous fan-out; a listener's throw is logged, never propagated. */
export function emitSystemChange(change: SystemChange): void {
  for (const l of [...listeners()]) {
    try {
      l(change);
    } catch (e) {
      console.error(`[agent-projects] change listener failed for ${change.action} on ${change.systemId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Test hook: drop every listener. */
export function __resetSystemListeners(): void {
  listeners().clear();
}
