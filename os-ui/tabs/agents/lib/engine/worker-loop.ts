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
 *   - RETENTION rides the same loop on a much slower cadence (`retentionEveryMs`), injected like
 *     everything else; a loop built without it simply never sweeps.
 *   - A LOST LEASE IS AN ABORT, not a log line (A4-review-H-2): `leaseWatch` flips `lost()` the
 *     first time a heartbeat reports that the row is no longer `running` under this worker, and
 *     `settlementOf` then says `abandon` — the run belongs to whoever re-claimed it, so this pod
 *     must neither settle it nor put it back. Both are pure, so the matrix is unit-tested.
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
  /** RETENTION (A13 follow-up): drop the checkpoint + `run_events` + `run_jobs` row of runs that
   *  settled outside the window. Injected so the loop stays pure; omit it and the loop never
   *  sweeps (which is what `AGENT_RUNS_RETENTION_DAYS=0` and the tests that predate it rely on). */
  sweepRetention?: () => Promise<void>;
  /** How often that sweep runs (ms of wall clock). Ignored when `sweepRetention` is absent. */
  retentionEveryMs?: number;
  sleep: (ms: number) => Promise<void>;
  /** True once SIGTERM arrived: no new claim is taken. */
  stopped: () => boolean;
  now?: () => number;
  log?: (message: string) => void;
};

export type TickOutcome = 'ran' | 'idle' | 'stopped';

/** The loop's own clock state: when each periodic chore last ran. `lastRetentionAt` is optional
 *  so a caller that predates retention (and every single-tick test) stays valid — absent means
 *  "never swept", i.e. due now, which is what a freshly started pod should do. */
export type WorkerLoopState = { lastReapAt: number; lastRetentionAt?: number };

// --------------------------------------------------------------- lease watch --

export type LeaseWatch = {
  /** One heartbeat. Flips `lost()` (and calls `onLost`) the first time the lease is gone. */
  tick: () => Promise<void>;
  lost: () => boolean;
};

/**
 * Watch one claimed run's lease. A heartbeat that returns `false` means the row is no longer
 * `running` under this worker — the reaper re-queued it and another pod may already be executing
 * it — so the run in this process must be ABORTED and left alone.
 * A heartbeat that THROWS is a database blip, not a lost lease: declaring the lease lost on a
 * failed query would abort healthy runs every time Postgres hiccups. The reaper stays the backstop.
 */
export function leaseWatch(opts: { heartbeat: () => Promise<boolean>; onLost?: (reason: string) => void }): LeaseWatch {
  let lost = false;
  return {
    lost: () => lost,
    async tick() {
      if (lost) return;
      let ok = true;
      try {
        ok = await opts.heartbeat();
      } catch {
        return; // a failed heartbeat query says nothing about the lease
      }
      if (ok) return;
      lost = true;
      opts.onLost?.('the lease is no longer held by this worker — the run was re-queued or re-claimed');
    },
  };
}

// ----------------------------------------------------------------- settle --

export type Settlement =
  | { kind: 'complete'; status: 'done' | 'parked' | 'failed'; error?: string }
  | { kind: 'requeue' }
  | { kind: 'abandon'; reason: string };

/**
 * What to do with a job whose execution just returned. PURE — the executor supplies the facts.
 * `abandon` wins over everything: a worker that lost its lease owns nothing to settle.
 */
export function settlementOf(o: { leaseLost: boolean; stopping: boolean; failure?: string; parked?: boolean; reachedEnd?: boolean }): Settlement {
  if (o.leaseLost) return { kind: 'abandon', reason: 'the lease was lost — another worker owns this run now' };
  if (o.failure !== undefined) return { kind: 'complete', status: 'failed', error: o.failure };
  // SIGTERM between supersteps: what completed is checkpointed, so the run goes BACK to the queue.
  if (o.stopping && !o.parked && !o.reachedEnd) return { kind: 'requeue' };
  return { kind: 'complete', status: o.parked ? 'parked' : 'done' };
}

/** One iteration: reap if due, sweep retention if due, claim one job, execute it under a heartbeat. */
export async function workerTick(deps: WorkerLoopDeps, state: WorkerLoopState): Promise<TickOutcome> {
  const now = deps.now ?? (() => Date.now());
  if (deps.stopped()) return 'stopped';
  // RETENTION is a CHORE: it runs on its own slow cadence, before the claim so a long backlog
  // cannot wedge between claiming and executing, and it can never throw — `sweepRetention` is
  // contracted not to, and this guard is the belt to that brace. A failed sweep costs disk, a
  // failed claim costs runs; they must not be able to take each other down.
  const retentionEvery = deps.retentionEveryMs ?? 0;
  if (deps.sweepRetention && retentionEvery > 0 && now() - (state.lastRetentionAt ?? 0) >= retentionEvery) {
    state.lastRetentionAt = now();
    try {
      await deps.sweepRetention();
    } catch (e) {
      deps.log?.(`retention sweep failed: ${(e as Error)?.message ?? String(e)}`);
    }
  }
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
      await deps.store.complete(job.runId, 'failed', { error: (e as Error)?.message ?? String(e), lockedBy: deps.workerId });
    } catch { /* the reaper is the backstop */ }
  } finally {
    stopHeartbeat();
  }
  return 'ran';
}

/** Loop until `stopped()`. Returns when the current job has settled — never mid-superstep. */
export async function workerLoop(deps: WorkerLoopDeps): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  // Both chores are due on the FIRST tick: a pod that has been down for a week should reap and
  // sweep immediately, not after another 6 hours of uptime.
  const state: WorkerLoopState = { lastReapAt: now() - deps.reapEveryMs, lastRetentionAt: now() - (deps.retentionEveryMs ?? 0) };
  for (;;) {
    const outcome = await workerTick(deps, state);
    if (outcome === 'stopped') return;
    if (outcome === 'idle') await deps.sleep(deps.idleMs);
  }
}
