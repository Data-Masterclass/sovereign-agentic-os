/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The worker loop — claim one run, execute it, reap the leases nobody renewed
 * USER STORY: As an operator I want the `os-ui-worker` pod to take one queued run at a time, to keep
 *             saying "I am still on it" while it runs, to put the run back if I SIGTERM the pod mid-
 *             superstep (the checkpoint continues it), and to never leave a run `running` forever
 *             because the pod that claimed it died — once re-queued, then failed visibly.
 * ARCHITECTURE:
 *   - PURE: the store, the executor, the clock and `sleep` are injected, so the whole failure
 *     matrix (stale lease, exhausted attempts, SIGTERM between supersteps) is unit-tested without a
 *     database, a pod or a timer. `build/run-jobs-server.ts` supplies the real deps.
 *   - ONE claim at a time (`replicas: 1`, and the claim is `FOR UPDATE SKIP LOCKED` so a second
 *     replica is safe too). `tick()` returns what it did, so a caller can test a single step.
 *   - The EXECUTOR owns the terminal transition (`done` / `parked` / `failed` / `requeue`): only it
 *     knows whether the graph reached END, parked on an approval, or stopped mid-superstep on
 *     SIGTERM. The loop only claims, heartbeats and reaps.
 *   - GRACEFUL STOP: `stopped()` is checked before each claim, so a SIGTERM never starts a new run;
 *     the in-flight one is aborted at its next superstep boundary by the executor's signal and the
 *     job goes back to `queued` as a `resume`.
 */
import type { RunJob, RunJobStore } from '@tabs/agents/lib/engine/jobs';

export type WorkerLoopDeps = {
  store: RunJobStore;
  /** This pod's identity — what `locked_by` records (`<hostname>/<pid>`). */
  workerId: string;
  /** Execute the claimed job AND settle it (done/parked/failed/requeued). Must not throw. */
  execute: (job: RunJob) => Promise<void>;
  /** Keep the lease alive while `execute` runs; returns the stop function. */
  heartbeat?: (runId: string) => () => void;
  /** A `running` lease older than this is stale. */
  leaseMs: number;
  /** Claims a job may accumulate before it is failed instead of re-queued. */
  maxAttempts: number;
  /** Pause between empty polls. */
  idleMs: number;
  /** How often the loop reaps stale leases (ms of wall clock between sweeps). */
  reapEveryMs: number;
  sleep: (ms: number) => Promise<void>;
  /** True once SIGTERM arrived: no new claim is taken. */
  stopped: () => boolean;
  now?: () => number;
  log?: (message: string) => void;
};

export type TickOutcome = 'ran' | 'idle' | 'stopped';

/** One iteration: reap if due, claim one job, execute it under a heartbeat. */
export async function workerTick(deps: WorkerLoopDeps, state: { lastReapAt: number }): Promise<TickOutcome> {
  const now = deps.now ?? (() => Date.now());
  if (deps.stopped()) return 'stopped';
  if (now() - state.lastReapAt >= deps.reapEveryMs) {
    state.lastReapAt = now();
    try {
      const { requeued, failed } = await deps.store.reapStale({ olderThanMs: deps.leaseMs, maxAttempts: deps.maxAttempts, now: now() });
      for (const id of requeued) deps.log?.(`re-queued run ${id}: its worker stopped renewing the lease (attempt ${deps.maxAttempts} is the last)`);
      for (const id of failed) deps.log?.(`FAILED run ${id}: the lease expired ${deps.maxAttempts} time(s) without completing`);
    } catch (e) {
      deps.log?.(`lease reap failed: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  let job: RunJob | null = null;
  try {
    job = await deps.store.claim(deps.workerId, now());
  } catch (e) {
    deps.log?.(`claim failed: ${(e as Error)?.message ?? String(e)}`);
    return 'idle';
  }
  if (!job) return 'idle';
  const stopHeartbeat = deps.heartbeat?.(job.runId) ?? (() => undefined);
  try {
    await deps.execute(job);
  } catch (e) {
    // `execute` is contracted not to throw; if it does, the job must not stay `running`.
    deps.log?.(`run ${job.runId} executor threw: ${(e as Error)?.message ?? String(e)}`);
    try {
      await deps.store.complete(job.runId, 'failed', { error: (e as Error)?.message ?? String(e) });
    } catch { /* the reaper is the backstop */ }
  } finally {
    stopHeartbeat();
  }
  return 'ran';
}

/** Loop until `stopped()`. Returns when the current job has settled — never mid-superstep. */
export async function workerLoop(deps: WorkerLoopDeps): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const state = { lastReapAt: now() - deps.reapEveryMs };
  for (;;) {
    const outcome = await workerTick(deps, state);
    if (outcome === 'stopped') return;
    if (outcome === 'idle') await deps.sleep(deps.idleMs);
  }
}
