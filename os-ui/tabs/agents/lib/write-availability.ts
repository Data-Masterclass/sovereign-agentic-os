/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Where an agent-system DEFINITION may be changed — and where it fails closed
 * USER STORY: As an operator I want a write that cannot be committed to be REFUSED rather than
 *             silently applied: the `os-ui-worker` pod executes agent runs, mounts no `os-repos`
 *             volume and carries no `DATA_PROJECT_GIT`, so a definition change made there would
 *             land in the durable mirror with NO commit and no mirror push — the repository would
 *             quietly stop being true. I would rather see a typed error (Part D review H-3).
 * ARCHITECTURE:
 *   - WHY NOT just mount the PVC in the worker: `os-repos` is `ReadWriteOnce`
 *     (charts/.../os-ui/os-repos.yaml). os-ui and os-ui-worker are separate Deployments that the
 *     scheduler may place on different nodes, and an RWO volume can only be attached to one node
 *     at a time — the worker pod would simply fail to start (or pin itself to os-ui's node). Two
 *     writers to one bare repo is also exactly what the single-writer lock in
 *     `core/infra/git-store.ts` cannot protect (it is in-process). So the worker does not write.
 *   - The marker is a PROCESS fact, set once by `worker/agent-runs.ts` at boot — not a config
 *     value, because both pods read the same configuration.
 *   - The chokepoint is the store's `writeThrough(rec, change)`: a non-null `change` is BY
 *     DEFINITION the set of writes that must become a commit (`lib/git/commit.test.ts` pins both
 *     lists), so this guard covers every one of them and, just as deliberately, covers none of
 *     the run/build bookkeeping a run legitimately performs here (`change === null`).
 *   - No import of the git store, the config or the store: this module must be safe to import from
 *     the store itself (no cycle) and from the worker entrypoint.
 */

const KEY = Symbol.for('soa.agents.run-worker-process');

/** The typed refusal of a definition change attempted where it could not be committed. */
export class SystemWriteUnavailableError extends Error {
  readonly code = 'run_worker_write_unavailable';
  readonly status = 503;
  constructor(action: string) {
    super(
      `agent-system mutations are not available from the run worker ('${action}'): the os-repos volume is ReadWriteOnce ` +
        'and is mounted by os-ui only, so this change could not be committed to the domain repository. ' +
        'Make it in os-ui (the Agents tab or the OS MCP) — nothing was written.',
    );
    this.name = 'SystemWriteUnavailableError';
  }
}

/** Declare THIS process the run worker. Called once by `worker/agent-runs.ts` at boot. */
export function markRunWorkerProcess(): void {
  (globalThis as unknown as Record<symbol, boolean>)[KEY] = true;
}

/** Is this process the run worker (and therefore unable to commit a definition change)? */
export function isRunWorkerProcess(): boolean {
  return (globalThis as unknown as Record<symbol, boolean>)[KEY] === true;
}

/** Test hook: forget the marker. */
export function __clearRunWorkerProcess(): void {
  delete (globalThis as unknown as Record<symbol, boolean>)[KEY];
}

/**
 * Throw {@link SystemWriteUnavailableError} when a committable change is attempted in the run
 * worker. A no-op everywhere else, including every `change === null` bookkeeping write.
 */
export function assertSystemWriteAvailable(action: string): void {
  if (isRunWorkerProcess()) throw new SystemWriteUnavailableError(action);
}
