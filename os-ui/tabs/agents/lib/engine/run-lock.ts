/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Per-thread in-flight lock — one entrant drives a run at a time
 * USER STORY: As a domain admin who just approved a held write I need it to execute exactly once as
 *             the runner, even if the runner clicks Resume (or an MCP client calls resume_agent_run)
 *             at the same moment: two concurrent resumes of one thread would both re-run `tools_<id>`
 *             from its start, both read the approval as approved, and both execute the write.
 * ARCHITECTURE:
 *   - A `globalThis`-pinned `Set<runId>` (route handlers are bundled separately; the set must be one).
 *     `acquireRunLock(runId)` throws a typed `RunInFlightError` (409) when the id is held and returns
 *     the release function otherwise; `executeTeamRun` releases in `finally`. Pure and synchronous —
 *     the lock is taken before any marker, event or checkpoint read.
 *   - Single replica, like the checkpointer and the run-event topic; A4's worker replaces it with the
 *     `run_jobs` row lock (`FOR UPDATE SKIP LOCKED`). Review finding A2 M-B.
 */

const LOCK_KEY = Symbol.for('soa.agents.run-locks');
function locks(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[LOCK_KEY]) g[LOCK_KEY] = new Set();
  return g[LOCK_KEY]!;
}

/** The thread is already being driven in this process — a second entrant must not re-run it. */
export class RunInFlightError extends Error {
  runId: string;
  status: number;
  constructor(runId: string) {
    super(`Run '${runId}' is already in flight — wait for it to park or finish before resuming`);
    this.name = 'RunInFlightError';
    this.runId = runId;
    this.status = 409;
  }
}

/** Take the lock for `runId` or throw `RunInFlightError`. Returns the release function (idempotent). */
export function acquireRunLock(runId: string): () => void {
  const held = locks();
  if (held.has(runId)) throw new RunInFlightError(runId);
  held.add(runId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(runId);
  };
}

/** True while `runId` is being driven in this process. */
export function runInFlight(runId: string): boolean {
  return locks().has(runId);
}

/** Test-only: drop every lock. */
export function __resetRunLocks(): void {
  locks().clear();
}
