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
 *   - ONE claim at a time PER SLOT. A process runs `concurrency` slots (`workerPool`), each its own
 *     loop with its own lease identity (`<pod>/<pid>#<slot>`), so a slot never mistakes a sibling's
 *     re-claim of a reaped run for its own lease. The claim is `FOR UPDATE SKIP LOCKED`, so slots
 *     and replicas never take the same job. Only slot 0 reaps and sweeps retention (chores are per
 *     process, not per slot). `tick()` returns what it did, so a caller can test a single step.
 *   - The EXECUTOR owns the terminal transition (`done` / `parked` / `failed` / `requeue`): only it
 *     knows whether the graph reached END, parked on an approval, or stopped mid-superstep on
 *     SIGTERM. The loop only claims, heartbeats and reaps.
 *   - GRACEFUL STOP: `stopped()` is checked before each claim, so a SIGTERM never starts a new run;
 *     the in-flight one is aborted at its next superstep boundary by the executor's signal and the
 *     job goes back to `queued` as a `resume`.
 *   - POLICY GATE (`policyReady`): while OPA's runtime policy state is missing (the canary the
 *     os-ui OPA reconciler writes is absent), no run is claimed; past `policyGateTimeoutMs` the
 *     oldest queued run is failed with the typed `policy_state_not_restored` error per tick.
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
  /**
   * POLICY GATE (OPA state reconcile): is OPA's runtime policy state in place? Injected so the loop
   * stays pure. While it answers false, no job is claimed (runs stay `queued`); once it has been
   * false for `policyGateTimeoutMs`, each tick claims the oldest job and fails it with the typed
   * error `policy_state_not_restored` instead of running an agent against empty OPA state.
   * Omitted ⇒ no gate (the tests that predate it).
   */
  policyReady?: () => Promise<boolean>;
  policyGateTimeoutMs?: number;
};

/** The typed failure a run gets when OPA's policy state stays missing past the gate timeout. */
export const POLICY_STATE_NOT_RESTORED = 'policy_state_not_restored';
export const DEFAULT_POLICY_GATE_TIMEOUT_MS = 5 * 60_000;

export type TickOutcome = 'ran' | 'idle' | 'stopped';

/** The loop's own clock state: when each periodic chore last ran. `lastRetentionAt` is optional
 *  so a caller that predates retention (and every single-tick test) stays valid — absent means
 *  "never swept", i.e. due now, which is what a freshly started pod should do. */
export type WorkerLoopState = { lastReapAt: number; lastRetentionAt?: number; policyNotReadySince?: number | null };

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
export function settlementOf(o: {
  leaseLost: boolean;
  stopping: boolean;
  /** The execution THREW (a refused resume, a compile error, an infrastructure failure). */
  failure?: string;
  parked?: boolean;
  reachedEnd?: boolean;
  /**
   * The execution returned normally but an AGENT failed and the run stopped there — the reason.
   * Such a run is `failed`, not `done`: it used to settle `done` because nothing had thrown.
   */
  failed?: string;
}): Settlement {
  if (o.leaseLost) return { kind: 'abandon', reason: 'the lease was lost — another worker owns this run now' };
  if (o.failure !== undefined) return { kind: 'complete', status: 'failed', error: o.failure };
  // An agent failure ENDS the graph: there is nothing to resume, so it is settled even under SIGTERM.
  if (o.failed !== undefined && !o.parked) return { kind: 'complete', status: 'failed', error: o.failed };
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
  if (deps.policyReady) {
    let ready = false;
    try {
      ready = await deps.policyReady();
    } catch (e) {
      deps.log?.(`policy gate check failed (treated as not restored): ${(e as Error)?.message ?? String(e)}`);
    }
    if (ready) {
      if (state.policyNotReadySince != null) deps.log?.('policy state restored — claiming runs again');
      state.policyNotReadySince = null;
    } else {
      if (state.policyNotReadySince == null) {
        state.policyNotReadySince = now();
        deps.log?.('policy state NOT restored in OPA — runs stay queued until it is');
      }
      const timeout = deps.policyGateTimeoutMs ?? DEFAULT_POLICY_GATE_TIMEOUT_MS;
      if (now() - state.policyNotReadySince < timeout) return 'idle';
      let stale: RunJob | null = null;
      try {
        stale = await deps.store.claim(deps.workerId, now());
      } catch (e) {
        deps.log?.(`claim failed: ${(e as Error)?.message ?? String(e)}`);
        return 'idle';
      }
      if (!stale) return 'idle';
      const error = `${POLICY_STATE_NOT_RESTORED}: OPA policy state has not been restored for ${Math.round((now() - state.policyNotReadySince) / 1000)} s — the run was not started`;
      try {
        await deps.store.appendEvent(stale.runId, 'error', { error, code: POLICY_STATE_NOT_RESTORED }, now());
        await deps.store.complete(stale.runId, 'failed', { error, lockedBy: deps.workerId, now: now() });
      } catch (e) {
        deps.log?.(`run ${stale.runId}: could not record ${POLICY_STATE_NOT_RESTORED} (${(e as Error)?.message ?? String(e)}); the reaper is the backstop`);
      }
      deps.log?.(`FAILED run ${stale.runId}: ${error}`);
      return 'ran';
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
  // sweep immediately, not after another 6 hours of uptime. A slot with no chores (`slotDeps`,
  // reapEveryMs = Infinity) never reaps.
  const state: WorkerLoopState = { lastReapAt: Number.isFinite(deps.reapEveryMs) ? now() - deps.reapEveryMs : now(), lastRetentionAt: now() - (deps.retentionEveryMs ?? 0) };
  for (;;) {
    const outcome = await workerTick(deps, state);
    if (outcome === 'stopped') return;
    if (outcome === 'idle') await deps.sleep(deps.idleMs);
  }
}

// ------------------------------------------------------------------ pool --

/**
 * The deps for slot `slot` of a pool: its own lease identity, and the per-process chores (lease
 * reap, retention sweep) only on slot 0. PURE, so the split is unit-tested.
 */
export function slotDeps(base: WorkerLoopDeps, slot: number, concurrency: number): WorkerLoopDeps {
  if (concurrency <= 1) return base;
  const id = `${base.workerId}#${slot}`;
  if (slot === 0) return { ...base, workerId: id };
  const { sweepRetention: _sweep, retentionEveryMs: _every, ...rest } = base;
  return { ...rest, workerId: id, reapEveryMs: Number.POSITIVE_INFINITY };
}

/**
 * Run `concurrency` worker loops in this process (`AGENTS_WORKER_CONCURRENCY`). `depsFor(slot)` builds
 * each slot's deps (its own abort controller and lease keeper live there); `slotDeps` then gives it its
 * identity and chores. Resolves when every slot has stopped — each only between runs.
 */
export async function workerPool(depsFor: (slot: number) => WorkerLoopDeps, concurrency: number): Promise<void> {
  const n = Math.max(1, Math.floor(concurrency) || 1);
  await Promise.all(Array.from({ length: n }, (_, slot) => workerLoop(slotDeps(depsFor(slot), slot, n))));
}
