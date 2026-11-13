/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The run queue, wired — enqueue from every door, execute inline or in the worker
 * USER STORY: As a builder I press Run and the run is FILED, not tied to my request: it executes in
 *             the worker pod, writes its events to `run_events`, and my panel tails them — so a run
 *             longer than the request cap finishes and a rolling restart continues it from its
 *             checkpoint instead of losing it. On a laptop (or in a test) the same code path runs the
 *             job in the same process, writing the same events, so behaviour is identical.
 * ARCHITECTURE:
 *   - ONE door: `enqueueRunJob` (start) / `enqueueResumeJob` (a Governance decision, owner Resume,
 *     MCP) insert or re-queue the run's `run_jobs` row. `AGENTS_WORKER=inline` (default) then runs
 *     it at once in this process (`void drainOne`); `worker` leaves it for `os-ui-worker`.
 *   - The EXECUTOR (`executeJob`) is the single place a run is driven: it re-reads the runner LIVE
 *     (`principalById`) and refuses typed when the identity the job was filed under no longer holds
 *     (gone/disabled, role downgraded, domain lost) — exactly A2's resume rule, applied to the
 *     queue; prepares the governed yaml AS THE RUNNER; drives `executeTeamRun` with a `run_events`
 *     sink; then settles the row (`done` / `parked` / `failed`, or back to `queued` when SIGTERM
 *     stopped it mid-superstep — the checkpoint continues it).
 *   - The store: Postgres when `AGENT_RUNS_DATABASE_URL` is set (same database as the checkpointer),
 *     else ONE process-wide in-memory store — a laptop keeps working, and the run report's
 *     `checkpointer: 'memory'` already says the durability is not real.
 *   - `server-only`: it touches the store, config and the run service. The pure parts it drives
 *     (`engine/jobs.ts`, `engine/worker-loop.ts`) are what the tests exercise.
 */
import 'server-only';
import { hostname } from 'node:os';
import type { CurrentUser } from '@core/kernel/auth';
import { principalById } from '@core/kernel/auth';
import { hydrateRunner as hydrate, principalSnapshotOf as snapshotOf, type HydratedRunner, type PrincipalLoader } from '@tabs/agents/lib/engine/runner-identity';
import { config } from '@core/kernel/config';
import type { AgentsWorkerMode } from '@core/kernel/agents-worker';
import {
  isTerminalEvent,
  memoryRunJobStore,
  runEventSink,
  tailRunEvents,
  type NewRunJob,
  type PrincipalSnapshot,
  type RunEventRow,
  type RunJob,
  type RunJobStore,
} from '@tabs/agents/lib/engine/jobs';
import { runJobStoreFor } from '@tabs/agents/lib/engine/jobs-postgres';
import { workerLoop, type WorkerLoopDeps } from '@tabs/agents/lib/engine/worker-loop';
import { currentUserOf, executeTeamRun, prepareRunYaml, type RunReportBody } from '@tabs/agents/lib/build/run-service';
import type { LivePrincipal } from '@tabs/agents/lib/engine/resume';
import type { ApprovalDecision } from '@tabs/agents/lib/engine/approval-port';
import type { Approval } from '@core/policy/approvals';
import { getSystemForRun } from '@tabs/agents/lib/store';
import { publishRunEvent } from '@tabs/agents/lib/engine/run-events';

// ------------------------------------------------------------------ store --

type StoreSlot = { store?: Promise<RunJobStore>; url?: string };
const slot = globalThis as unknown as { __osRunJobsStore?: StoreSlot };

/** The run-job store for this process (Postgres when configured, else one in-memory store). */
export function runJobStore(): Promise<RunJobStore> {
  slot.__osRunJobsStore ??= {};
  const s = slot.__osRunJobsStore;
  const url = (config.agentRunsDatabaseUrl ?? '').trim();
  if (!s.store || s.url !== url) {
    s.url = url;
    s.store = url ? runJobStoreFor(url) : Promise.resolve(memoryRunJobStore());
  }
  return s.store;
}

/** Boot-time init: create `run_jobs` / `run_events` if needed. Returns the store kind. */
export async function ensureRunJobsReady(): Promise<'postgres' | 'memory'> {
  return (await runJobStore()).kind;
}

/** This pod's `locked_by` identity. */
export function workerId(): string {
  return `${process.env.HOSTNAME || hostname()}/${process.pid}`;
}

/** The mode this process runs in. */
export function workerMode(): AgentsWorkerMode {
  return config.agentsWorker;
}

// -------------------------------------------------------------- principal --

/** The live user directory bound to the pure rule in `engine/runner-identity.ts`. */
export function hydrateRunner(snapshot: PrincipalSnapshot, domain: string, load: PrincipalLoader = principalById): Promise<HydratedRunner> {
  return hydrate(snapshot, domain, load);
}
export { principalSnapshotOf } from '@tabs/agents/lib/engine/runner-identity';
export type { RunnerRefusal, HydratedRunner } from '@tabs/agents/lib/engine/runner-identity';

// --------------------------------------------------------------- enqueue --

export type EnqueueInput = Omit<NewRunJob, 'principal'> & { user: CurrentUser };

export type QueuedRun = {
  runId: string;
  mode: AgentsWorkerMode;
  /** `inline` only: resolves when the run has settled (so a non-streaming caller can await it). */
  inflight?: Promise<void>;
};

/**
 * File a run. In `inline` mode the same process claims and executes it at once (fire-and-forget;
 * `inflight` is the handle), writing the SAME `run_events` a worker would — the only difference
 * between the modes is which process does the work.
 */
export async function enqueueRun(input: EnqueueInput): Promise<QueuedRun> {
  const store = await runJobStore();
  const job: NewRunJob = {
    runId: input.runId,
    systemId: input.systemId,
    domain: input.domain,
    requestedBy: input.requestedBy,
    principal: snapshotOf(input.user),
    input: input.input,
    kind: input.kind,
  };
  await store.enqueue(job);
  const mode = workerMode();
  if (mode === 'worker') return { runId: input.runId, mode };
  return { runId: input.runId, mode, inflight: drainOne(input.runId) };
}

/** Claim ONE specific queued job in this process and execute it (inline mode, and tests). */
export async function drainOne(runId: string): Promise<void> {
  const store = await runJobStore();
  const job = await store.claimById(runId, workerId());
  if (!job) return;
  await executeJob(store, job, {});
}

// --------------------------------------------------------------- execute --

export type ExecuteJobOptions = {
  /** Aborted on SIGTERM: LangGraph stops at the next superstep boundary and the job is re-queued. */
  signal?: AbortSignal;
  /** True when the abort above is what stopped the run (so it is re-queued, not finished). */
  stopping?: () => boolean;
  log?: (message: string) => void;
};

/**
 * Drive one claimed job to a settled state. NEVER throws: every outcome is a row transition plus,
 * for a refusal, one terminal `error` event so a tail does not hang.
 */
export async function executeJob(store: RunJobStore, job: RunJob, opts: ExecuteJobOptions): Promise<void> {
  const sink = runEventSink(store, job.runId);
  const emit = (event: string, data: unknown) => {
    sink.write(event, data);
    // Keep the in-process topic alive too: in inline mode a panel attached before A4 still works.
    publishRunEvent(job.runId, event, data);
  };
  const settle = async (status: 'done' | 'parked' | 'failed', error?: string) => {
    await sink.drained();
    for (const p of sink.problems()) opts.log?.(`run ${job.runId}: ${p}`);
    await store.complete(job.runId, status, { error });
  };

  const hydrated = await hydrateRunner(job.principal, job.domain);
  if ('refused' in hydrated) {
    emit('error', { error: hydrated.refused.reason, code: hydrated.refused.code });
    opts.log?.(`run ${job.runId} refused: ${hydrated.refused.code} — ${hydrated.refused.reason}`);
    await settle('failed', `${hydrated.refused.code}: ${hydrated.refused.reason}`);
    return;
  }
  const user = hydrated.user;

  try {
    const view = getSystemForRun(job.systemId, user);
    const yaml = await prepareRunYaml(user, view, job.systemId);
    const body = await executeTeamRun({
      user,
      systemId: job.systemId,
      view,
      yaml,
      messages: job.input.messages ?? [],
      engine: 'langgraph',
      runId: job.runId,
      resume: job.kind === 'resume',
      resumeWith: job.input.resumeWith,
      prompt: job.input.prompt,
      signal: opts.signal,
      emit,
    });
    // SIGTERM between supersteps: what completed is checkpointed, so the run goes BACK to the
    // queue as a resume rather than being reported finished.
    if (opts.stopping?.() && !body.parked && !body.reachedEnd) {
      await sink.drained();
      await store.requeue(job.runId, job.lockedBy ?? workerId());
      opts.log?.(`run ${job.runId} re-queued: the worker is shutting down and the run stopped mid-superstep`);
      return;
    }
    await settle(body.parked ? 'parked' : 'done');
  } catch (e) {
    const err = e as Error & { status?: number };
    const message = err?.message ?? String(e);
    // `executeTeamRun` publishes `error` itself for a real failure but NOT for a refused resume
    // (404/409) — those never looked like a run, so the tail needs a terminal frame from here.
    if (err?.status === 404 || err?.status === 409) emit('error', { error: message, status: err.status });
    await settle('failed', message);
  }
}

// ---------------------------------------------------------------- worker --

export type WorkerHandle = { stop: () => void; done: Promise<void> };

/**
 * Start the worker loop in this process. Returns a handle whose `stop()` is what SIGTERM calls:
 * no new job is claimed and the in-flight one is aborted at its next superstep boundary, so the
 * pod's `terminationGracePeriodSeconds` only has to cover ONE superstep.
 */
export function startAgentRunsWorker(overrides: Partial<WorkerLoopDeps> = {}): WorkerHandle {
  const id = overrides.workerId ?? workerId();
  const lease = config.agentsWorkerLeaseMs;
  let stopping = false;
  let abort: AbortController | null = null;
  const log = overrides.log ?? ((m: string) => console.info(`[agent-runs-worker] ${m}`));

  const done = (async () => {
    const store = overrides.store ?? (await runJobStore());
    log(`started as ${id}; store=${store.kind}, lease=${lease}ms`);
    const deps: WorkerLoopDeps = {
      store,
      workerId: id,
      leaseMs: lease,
      maxAttempts: 2,
      idleMs: 1_000,
      reapEveryMs: Math.max(30_000, Math.floor(lease / 2)),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      stopped: () => stopping,
      log,
      heartbeat: (runId) => {
        const timer = setInterval(() => {
          void store.heartbeat(runId, id).then((ok) => {
            if (!ok) log(`run ${runId}: lease lost (another worker or the reaper took it) — this pod stops heartbeating`);
          });
        }, Math.max(5_000, Math.floor(lease / 3)));
        timer.unref?.();
        return () => clearInterval(timer);
      },
      execute: async (job) => {
        abort = new AbortController();
        try {
          await executeJob(store, job, { signal: abort.signal, stopping: () => stopping, log });
        } finally {
          abort = null;
        }
      },
      ...overrides,
    };
    await workerLoop(deps);
    log('loop finished (stop requested)');
  })();

  return {
    stop: () => {
      stopping = true;
      abort?.abort();
    },
    done,
  };
}

// ------------------------------------------------------------------ doors --

export type StartRunInput = {
  user: CurrentUser;
  systemId: string;
  /** The system's domain (what the job row records, and what the live runner must still be in). */
  domain: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  prompt?: string;
  /** Mint one with `newRunId()` when the caller wants to report it before the run finishes. */
  runId: string;
  /** How long to follow the run before returning without a report (worker mode). */
  waitMs?: number;
  signal?: AbortSignal;
};

export type StartedRunReport = {
  runId: string;
  mode: AgentsWorkerMode;
  /** The run report (the `done` frame body), or undefined when the run is still executing. */
  body?: RunReportBody;
  /** Set when the run failed before producing a report. */
  error?: { message: string; status?: number };
};

/**
 * The ONE start door behind the run route, the scheduler and the MCP `run_agent_system`: file the
 * job, then follow it until it settles. In `inline` mode the follow is immediate (the run executed
 * in this call); in `worker` mode it tails `run_events` until the budget runs out and then hands
 * back just the run id — the caller reports a queued run instead of inventing a result.
 */
export async function startQueuedRun(input: StartRunInput): Promise<StartedRunReport> {
  const queued = await enqueueRun({
    runId: input.runId,
    systemId: input.systemId,
    domain: input.domain,
    requestedBy: input.user.id,
    user: input.user,
    kind: 'start',
    input: { messages: input.messages, prompt: input.prompt },
  });
  return followRun(queued, { waitMs: input.waitMs, signal: input.signal });
}

/** Re-queue a parked/finished thread as a `resume` job and follow it the same way. */
export async function resumeQueuedRun(input: {
  user: CurrentUser;
  systemId: string;
  domain: string;
  runId: string;
  resumeWith?: Record<string, ApprovalDecision>;
  waitMs?: number;
  signal?: AbortSignal;
}): Promise<StartedRunReport> {
  const queued = await enqueueRun({
    runId: input.runId,
    systemId: input.systemId,
    domain: input.domain,
    requestedBy: input.user.id,
    user: input.user,
    kind: 'resume',
    input: { messages: [], resumeWith: input.resumeWith },
  });
  return followRun(queued, { waitMs: input.waitMs, signal: input.signal });
}

/** Follow a filed run to its report (or to the point where the caller must tail it instead). */
export async function followRun(queued: QueuedRun, opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<StartedRunReport> {
  const store = await runJobStore();
  if (queued.inflight) await queued.inflight;
  const seen: RunEventRow[] = [];
  await tailRunEvents(store, queued.runId, { until: 'settled', afterSeq: 0, signal: opts.signal, timeoutMs: opts.waitMs ?? (queued.mode === 'inline' ? 30_000 : 240_000) }, (ev) => { seen.push(ev); });
  const last = seen.filter(isTerminalEvent).at(-1) ?? seen.filter((e) => e.event === 'done').at(-1);
  if (!last) return { runId: queued.runId, mode: queued.mode };
  if (last.event === 'error') {
    const d = (last.data ?? {}) as { error?: string; status?: number };
    return { runId: queued.runId, mode: queued.mode, error: { message: d.error ?? 'the run failed', status: d.status } };
  }
  return { runId: queued.runId, mode: queued.mode, body: last.data as RunReportBody };
}

/**
 * The `onDecided` hook's resume (A4): the decision does NOT drive the graph inside the decider's
 * request any more — it files a `resume` job, which inline mode executes here and worker mode
 * executes in the worker. ONE code path in both pods.
 */
export async function enqueueResumeAfterDecision(input: { runner: LivePrincipal; approval: Approval; decision: ApprovalDecision }): Promise<{ parked: boolean; reachedEnd: boolean; queued?: boolean }> {
  const a = input.approval;
  if (!a.runId || !a.systemId) throw new Error('resume: the approval carries no run');
  const user = currentUserOf(input.runner);
  const view = getSystemForRun(a.systemId, user);
  const domain = view.system.system.domain;
  const store = await runJobStore();
  // The `resumed` frame is written BEFORE the job is filed, so it precedes the resumed run's own
  // events in `seq` order no matter which pod executes them.
  await store.appendEvent(a.runId, 'resumed', { approvalId: a.id, decision: input.decision }).catch(() => undefined);
  publishRunEvent(a.runId, 'resumed', { approvalId: a.id, decision: input.decision });
  const out = await resumeQueuedRun({ user, systemId: a.systemId, domain, runId: a.runId, resumeWith: { [a.id]: input.decision } });
  if (out.error) throw Object.assign(new Error(out.error.message), { status: out.error.status });
  if (!out.body) return { parked: false, reachedEnd: false, queued: true };
  return { parked: out.body.parked, reachedEnd: out.body.reachedEnd };
}
