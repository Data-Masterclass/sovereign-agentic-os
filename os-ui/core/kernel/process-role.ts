/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Which process am I — the web app (`os-ui`) or the agent-run worker (`os-ui-worker`)?
 * USER STORY: As an operator I want every store to know when it runs inside the worker, so a
 *             write made there never re-creates a record the web app deleted, and an agent-system
 *             definition change made there fails closed instead of skipping its commit.
 * ARCHITECTURE:
 *   - A PROCESS fact, set once by `worker/agent-runs.ts` at boot — not configuration, because
 *     both pods run the same image with the same configuration.
 *   - Pinned to `globalThis` (one answer for every separately bundled route handler). The symbol
 *     is the one `tabs/agents/lib/write-availability.ts` used before this moved to core, so the
 *     marker keeps its meaning across the move.
 *   - No imports: safe to import from any store and from the worker entrypoint (no cycle).
 */

const KEY = Symbol.for('soa.agents.run-worker-process');

/** Declare THIS process the run worker. Called once by `worker/agent-runs.ts` at boot. */
export function markRunWorkerProcess(): void {
  (globalThis as unknown as Record<symbol, boolean>)[KEY] = true;
}

/** Is this process the run worker? */
export function isRunWorkerProcess(): boolean {
  return (globalThis as unknown as Record<symbol, boolean>)[KEY] === true;
}

/** Test hook: forget the marker. */
export function __clearRunWorkerProcess(): void {
  delete (globalThis as unknown as Record<symbol, boolean>)[KEY];
}
