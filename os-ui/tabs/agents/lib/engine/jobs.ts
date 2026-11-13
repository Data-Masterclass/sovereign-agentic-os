/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Run job store — the `run_jobs` queue and the `run_events` log of one agent run
 * USER STORY: As the run route I want to ENQUEUE a run and TAIL its events from any os-ui pod; as
 *             the worker I want to CLAIM exactly one queued job at a time (never the same job twice
 *             across pods), heartbeat my lease, and mark it done / parked / failed; as an operator I
 *             want a job whose worker died to be picked up again from its checkpoint — once — and
 *             then to fail visibly, never to sit `running` forever.
 * ARCHITECTURE:
 *   - A port (`RunJobStore`) with two implementations: `memoryRunJobStore()` here (tests, and the
 *     laptop/kind install without `AGENT_RUNS_DATABASE_URL`) and `jobs-postgres.ts` (the
 *     `agent_runs` database, same one as the LangGraph checkpointer). Both honour the same
 *     contract, tested against the memory store in `jobs.test.ts`; the Postgres SQL is tripwired
 *     separately.
 *   - ONE ROW PER RUN: `run_id` is the primary key. A `start` job inserts it; a `resume` job (owner
 *     Resume, MCP `resume_agent_run`, the approval-decision hook) re-queues the SAME row — a run
 *     that is `queued` or `running` cannot be re-queued (typed `RunJobConflictError`, 409: the
 *     cross-process form of A2's in-flight lock).
 *   - EVENTS carry exactly the SSE vocabulary the Run panel consumes (`RUN_EVENT_NAMES`), with a
 *     per-run increasing `seq`, so a tail from `seq=0` replays the whole run and a re-attach from a
 *     later `seq` gets only what it missed. A `done` whose body says `parked:true` is NOT terminal
 *     (the decision resumes the run on the same id); `error` and a non-parked `done` are.
 *   - LEASES: `claim` stamps `locked_by`/`locked_at` and bumps `attempts`; `heartbeat` refreshes
 *     `locked_at`; `reapStale` re-queues a `running` job whose lease expired (attempts < max) or
 *     fails it — KEEPING `kind='start'` for a job that never got a resume point (A4-review-M-5).
 *     `complete` is LEASE-GUARDED when the caller passes `lockedBy`: a holder whose lease was
 *     reaped and re-claimed elsewhere must not settle the run the new holder owns
 *     (A4-review-H-2); it returns whether the transition applied.
 *   - `appendEvent` is deliberately NOT lease-guarded. The engine's `emit` is synchronous and
 *     carries no lease holder, a late event from a stale holder is ordered after the new holder's
 *     by `seq` (never interleaved mid-event) and is at worst a duplicate line in the panel —
 *     whereas a stale `complete` would end a run the new holder is still executing. Guarding the
 *     settle transition is therefore the cut that matters (A4-review-H-2).
 *     No `server-only`, no env: pure.
 */
import type { Role } from '@core/kernel/session';
import type { ApprovalDecision } from '@tabs/agents/lib/engine/approval-port';
import { RunNotVisibleError } from '@tabs/agents/lib/engine/run-visibility';

/** The SSE event vocabulary of a run — what `run_events.event` may hold. */
export const RUN_EVENT_NAMES = ['node-started', 'tool-step', 'node-completed', 'approval-required', 'resumed', 'done', 'error'] as const;
export type RunEventName = (typeof RUN_EVENT_NAMES)[number];

export function isRunEventName(v: unknown): v is RunEventName {
  return typeof v === 'string' && (RUN_EVENT_NAMES as readonly string[]).includes(v);
}

export type RunJobKind = 'start' | 'resume';
export type RunJobStatus = 'queued' | 'running' | 'parked' | 'done' | 'failed';

/** The runner's identity as it was when the job was filed — re-read LIVE before execution. */
export type PrincipalSnapshot = { id: string; name: string; role: Role; domains: string[]; activeDomain: string | null };

export type RunJobInput = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** A fresh run: the prompt recorded on the durable store checkpoint. */
  prompt?: string;
  /** A resume after a Governance decision: `{ [approvalId]: decision }` plus the approval to stamp. */
  resumeWith?: Record<string, ApprovalDecision>;
  approvalId?: string;
  decision?: ApprovalDecision;
};

export type NewRunJob = {
  runId: string;
  systemId: string;
  domain: string;
  requestedBy: string;
  principal: PrincipalSnapshot;
  input: RunJobInput;
  kind: RunJobKind;
};

export type RunJob = NewRunJob & {
  status: RunJobStatus;
  lockedBy: string | null;
  lockedAt: number | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** Set when `status === 'failed'`. Never a secret: the engine's error message, bounded. */
  error?: string;
};

export type RunEventRow = { runId: string; seq: number; event: RunEventName; data: unknown; at: number };

export type RunJobStoreKind = 'postgres' | 'memory';

/** No `run_jobs` row for this id — a resume of a run that never started (or was pruned). */
export class RunJobNotFoundError extends Error {
  runId: string;
  status: number;
  constructor(runId: string) {
    super(`No run '${runId}' to resume — it never started, or its job row is gone`);
    this.name = 'RunJobNotFoundError';
    this.runId = runId;
    this.status = 404;
  }
}

/** The run is queued or running — a second start/resume must not race it (A2 review M-B, cross-process). */
export class RunJobConflictError extends Error {
  runId: string;
  status: number;
  /** The state that refused the enqueue — `running` is the one worth retrying (A4-review-M-2). */
  state: RunJobStatus;
  constructor(runId: string, state: RunJobStatus) {
    super(`Run '${runId}' is already ${state} — wait for it to park or finish before resuming`);
    this.name = 'RunJobConflictError';
    this.runId = runId;
    this.status = 409;
    this.state = state;
  }
}

export type RunJobStore = {
  kind: RunJobStoreKind;
  /** Insert a `start` job, or re-queue the run's row as a `resume`. Throws `RunJobConflictError`. */
  enqueue(job: NewRunJob, now?: number): Promise<RunJob>;
  /** Claim the oldest `queued` job for `workerId` (atomic across processes); null when none. */
  claim(workerId: string, now?: number): Promise<RunJob | null>;
  /** Claim ONE specific queued job (inline mode: the process that enqueued executes its own). */
  claimById(runId: string, workerId: string, now?: number): Promise<RunJob | null>;
  /** Refresh the lease; false when the job is no longer `running` under this worker (lost lease). */
  heartbeat(runId: string, workerId: string, now?: number): Promise<boolean>;
  /** Terminal / parked transition; releases the lock. With `lockedBy` the transition applies ONLY
   *  while that worker still holds a `running` lease — a stale holder's settle is a no-op (false). */
  complete(runId: string, status: 'done' | 'parked' | 'failed', opts?: { error?: string; now?: number; lockedBy?: string }): Promise<boolean>;
  /** A graceful shutdown mid-run: back to `queued` as a `resume` (the checkpoint continues it). */
  requeue(runId: string, workerId: string, now?: number): Promise<void>;
  /** Re-queue (attempts < maxAttempts) or fail every `running` job whose lease is older than `olderThanMs`. */
  reapStale(opts: { olderThanMs: number; maxAttempts: number; now?: number }): Promise<{ requeued: string[]; failed: string[] }>;
  get(runId: string): Promise<RunJob | null>;
  /** Append one event with the next `seq` for the run. */
  appendEvent(runId: string, event: RunEventName, data: unknown, at?: number): Promise<RunEventRow>;
  /** Events with `seq > afterSeq`, ascending, at most `limit`. */
  eventsAfter(runId: string, afterSeq: number, limit?: number): Promise<RunEventRow[]>;
  /** The highest `seq` written for the run (0 when none). */
  lastSeq(runId: string): Promise<number>;
};

/** Statuses after which a job will not run again without a new enqueue. */
export function isSettled(status: RunJobStatus): boolean {
  return status === 'done' || status === 'parked' || status === 'failed';
}

/** `error`, or a `done` that is not parked. A parked `done` keeps the tail open for the decision. */
export function isTerminalEvent(ev: Pick<RunEventRow, 'event' | 'data'>): boolean {
  if (ev.event === 'error') return true;
  if (ev.event !== 'done') return false;
  const d = ev.data as { parked?: boolean } | null;
  return !(d && d.parked === true);
}

/** Upper bound on a persisted failure message. */
const ERROR_MAX = 2_000;
export function boundError(message: string): string {
  return message.length > ERROR_MAX ? `${message.slice(0, ERROR_MAX)}…` : message;
}

// ---------------------------------------------------------------------- memory store --

type MemoryState = { jobs: Map<string, RunJob>; events: Map<string, RunEventRow[]> };

export type MemoryRunJobStore = RunJobStore & {
  /** Test seams. */
  all(): RunJob[];
  events(runId: string): RunEventRow[];
  reset(): void;
};

/**
 * The in-memory store: the contract every implementation must meet, and the store a laptop/kind
 * install without the `agent_runs` database runs on (one process, so the queue needs no cross-
 * process lock — but the state machine is the same).
 */
export function memoryRunJobStore(): MemoryRunJobStore {
  const st: MemoryState = { jobs: new Map(), events: new Map() };
  const stamp = (n?: number) => n ?? Date.now();
  const copy = (j: RunJob): RunJob => ({ ...j, principal: { ...j.principal, domains: [...j.principal.domains] }, input: { ...j.input } });

  return {
    kind: 'memory',
    async enqueue(job, now) {
      const t = stamp(now);
      const existing = st.jobs.get(job.runId);
      if (existing) {
        // Defence in depth (A4-review-H-1): a resume filed by anyone but the run's requester is a
        // 404 BEFORE the row is touched — the doors check first, the store refuses regardless.
        if (job.kind === 'resume' && existing.requestedBy !== job.requestedBy) throw new RunNotVisibleError(job.runId);
        if (existing.status === 'queued' || existing.status === 'running') throw new RunJobConflictError(job.runId, existing.status);
        if (job.kind === 'start') throw new RunJobConflictError(job.runId, existing.status);
        const next: RunJob = {
          ...existing,
          kind: 'resume',
          requestedBy: job.requestedBy,
          principal: job.principal,
          input: job.input,
          status: 'queued',
          lockedBy: null,
          lockedAt: null,
          attempts: 0,
          updatedAt: t,
          error: undefined,
        };
        st.jobs.set(job.runId, next);
        return copy(next);
      }
      if (job.kind === 'resume') throw new RunJobNotFoundError(job.runId);
      const row: RunJob = { ...job, status: 'queued', lockedBy: null, lockedAt: null, attempts: 0, createdAt: t, updatedAt: t };
      st.jobs.set(job.runId, row);
      return copy(row);
    },
    async claim(workerId, now) {
      const t = stamp(now);
      const next = [...st.jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId))[0];
      if (!next) return null;
      Object.assign(next, { status: 'running', lockedBy: workerId, lockedAt: t, attempts: next.attempts + 1, updatedAt: t });
      return copy(next);
    },
    async claimById(runId, workerId, now) {
      const j = st.jobs.get(runId);
      if (!j || j.status !== 'queued') return null;
      const t = stamp(now);
      Object.assign(j, { status: 'running', lockedBy: workerId, lockedAt: t, attempts: j.attempts + 1, updatedAt: t });
      return copy(j);
    },
    async heartbeat(runId, workerId, now) {
      const j = st.jobs.get(runId);
      if (!j || j.status !== 'running' || j.lockedBy !== workerId) return false;
      j.lockedAt = stamp(now);
      return true;
    },
    async complete(runId, status, opts) {
      const j = st.jobs.get(runId);
      if (!j) return false;
      // Lease guard: a worker whose lease was reaped and re-claimed elsewhere must not settle the
      // run its new holder is executing (A4-review-H-2).
      if (opts?.lockedBy !== undefined && (j.status !== 'running' || j.lockedBy !== opts.lockedBy)) return false;
      const t = stamp(opts?.now);
      Object.assign(j, { status, lockedBy: null, lockedAt: null, updatedAt: t, error: status === 'failed' ? boundError(opts?.error ?? 'failed') : undefined });
      return true;
    },
    async requeue(runId, workerId, now) {
      const j = st.jobs.get(runId);
      if (!j || j.lockedBy !== workerId) return;
      Object.assign(j, { status: 'queued', kind: 'resume', lockedBy: null, lockedAt: null, updatedAt: stamp(now) });
    },
    async reapStale({ olderThanMs, maxAttempts, now }) {
      const t = stamp(now);
      const requeued: string[] = [];
      const failed: string[] = [];
      for (const j of st.jobs.values()) {
        if (j.status !== 'running' || j.lockedAt === null || t - j.lockedAt <= olderThanMs) continue;
        if (j.attempts < maxAttempts) {
          // A4-review-M-5: a run killed before its first checkpoint has nothing to resume FROM, so
          // the reaper keeps the row's original kind — a reaped `start` is re-STARTED, not resumed
          // (a resume of a thread with no checkpoint is a 404, i.e. a failure instead of a retry).
          Object.assign(j, { status: 'queued', kind: j.kind === 'start' ? 'start' : 'resume', lockedBy: null, lockedAt: null, updatedAt: t });
          requeued.push(j.runId);
        } else {
          Object.assign(j, { status: 'failed', lockedBy: null, lockedAt: null, updatedAt: t, error: `worker lease expired ${j.attempts} time(s) — the run was not completed` });
          failed.push(j.runId);
        }
      }
      return { requeued, failed };
    },
    async get(runId) {
      const j = st.jobs.get(runId);
      return j ? copy(j) : null;
    },
    async appendEvent(runId, event, data, at) {
      if (!isRunEventName(event)) throw new Error(`not a run event: ${String(event)}`);
      const list = st.events.get(runId) ?? [];
      const row: RunEventRow = { runId, seq: (list.at(-1)?.seq ?? 0) + 1, event, data, at: stamp(at) };
      list.push(row);
      st.events.set(runId, list);
      return row;
    },
    async eventsAfter(runId, afterSeq, limit = 500) {
      return (st.events.get(runId) ?? []).filter((e) => e.seq > afterSeq).slice(0, limit);
    },
    async lastSeq(runId) {
      return st.events.get(runId)?.at(-1)?.seq ?? 0;
    },
    all: () => [...st.jobs.values()].map(copy),
    events: (runId) => [...(st.events.get(runId) ?? [])],
    reset: () => { st.jobs.clear(); st.events.clear(); },
  };
}

// ----------------------------------------------------------------------------- tail --

export type TailOptions = {
  /** Start after this `seq` (0 = replay everything). */
  afterSeq?: number;
  /** `terminal`: end on `error` / non-parked `done` (the re-attach stream). `settled`: end as soon
   *  as the job is done/parked/failed and its events are drained (the POST run response). */
  until: 'terminal' | 'settled';
  pollMs?: number;
  /** Stop tailing (client disconnected). */
  signal?: AbortSignal;
  /** Give up after this long without the end condition (0 = never). */
  timeoutMs?: number;
};

export type TailOutcome = { ended: 'terminal' | 'settled' | 'aborted' | 'timeout' | 'missing'; lastSeq: number };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', done); clearTimeout(t); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Follow a run's events from the store, in `seq` order, calling `onEvent` for each. The tail is a
 * POLL (short interval, PK range scan on `(run_id, seq)`): it is correct across pods and after any
 * reconnect, needs no dedicated connection per watcher, and the panel's SSE cadence makes a few
 * hundred milliseconds of latency invisible. A `LISTEN/NOTIFY` wake-up would only shave latency
 * off this loop; it was not added (plan deviation A4-3).
 */
export async function tailRunEvents(store: Pick<RunJobStore, 'eventsAfter' | 'get'>, runId: string, opts: TailOptions, onEvent: (ev: RunEventRow) => void): Promise<TailOutcome> {
  let seq = opts.afterSeq ?? 0;
  const pollMs = opts.pollMs ?? 400;
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : 0;
  for (;;) {
    if (opts.signal?.aborted) return { ended: 'aborted', lastSeq: seq };
    const batch = await store.eventsAfter(runId, seq);
    for (const ev of batch) {
      seq = ev.seq;
      onEvent(ev);
      if (isTerminalEvent(ev)) return { ended: 'terminal', lastSeq: seq };
    }
    if (opts.until === 'settled') {
      const job = await store.get(runId);
      if (!job) return { ended: 'missing', lastSeq: seq };
      if (isSettled(job.status)) {
        // The status flips AFTER the final event is written; drain once more so nothing is lost.
        for (const ev of await store.eventsAfter(runId, seq)) { seq = ev.seq; onEvent(ev); }
        return { ended: 'settled', lastSeq: seq };
      }
    } else if (batch.length === 0) {
      // A job settled without a terminal event (should not happen) must not hang the tail
      // (A4-review-L-3). `parked` is excluded ON PURPOSE: a parked run is settled but NOT
      // finished — the decision resumes it on the same id and this tail is what shows that.
      const job = await store.get(runId);
      if (!job) return { ended: 'missing', lastSeq: seq };
      if (isSettled(job.status) && job.status !== 'parked') {
        // The status flips after the last event is written: drain once more before giving up.
        const rest = await store.eventsAfter(runId, seq);
        if (rest.length === 0) return { ended: 'settled', lastSeq: seq };
        continue;
      }
    }
    if (deadline && Date.now() >= deadline) return { ended: 'timeout', lastSeq: seq };
    await sleep(pollMs, opts.signal);
  }
}

// -------------------------------------------------------- resume enqueue --

/**
 * File a `resume` job, retrying while the row is still `running`.
 *
 * A4-review-M-2: a decision taken in the split second between the engine's `interrupt()` and the
 * executor's `complete(…, 'parked')` found the row `running` and was refused 409 — which stamped
 * the approval `failed` even though the decision was perfectly valid. The window is one `await`
 * wide, so a short bounded retry closes it; a row that is `queued` (a resume is already filed) or
 * that does not exist is NOT retried — those conflicts are real.
 */
export async function enqueueResumeWithRetry(
  store: Pick<RunJobStore, 'enqueue'>,
  job: NewRunJob,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RunJob> {
  const attempts = Math.max(1, opts.attempts ?? 5);
  const delayMs = opts.delayMs ?? 200;
  const nap = opts.sleep ?? ((ms: number) => sleep(ms));
  for (let i = 1; ; i += 1) {
    try {
      return await store.enqueue(job);
    } catch (e) {
      const conflict = e instanceof RunJobConflictError ? e : null;
      if (!conflict || conflict.state !== 'running' || i >= attempts) throw e;
      await nap(delayMs);
    }
  }
}

// ------------------------------------------------------------------- sink --

export type RunEventSink = {
  /** Record one event. Synchronous for the caller (the engine's `emit`), ordered on the wire. */
  write(event: string, data: unknown): void;
  /** Resolves when every accepted event has been persisted. Never rejects. */
  drained(): Promise<void>;
  /** Events the sink refused (not in the vocabulary) + write failures — surfaced, never thrown. */
  problems(): string[];
};

/**
 * Turn a store into the synchronous `emit(event, data)` the run service expects, persisting each
 * event with the next `seq`. Writes are SERIALISED on one promise chain, so `seq` order is the
 * order the engine emitted in — and `drained()` lets the caller flip the job's status only after
 * the last event is durable (the tail's "settled" check drains once more regardless).
 * An event outside {@link RUN_EVENT_NAMES} is dropped and reported, never persisted: the table is
 * the SSE contract, not a free-form log.
 */
export function runEventSink(store: Pick<RunJobStore, 'appendEvent'>, runId: string): RunEventSink {
  let chain: Promise<unknown> = Promise.resolve();
  const problems: string[] = [];
  return {
    write(event, data) {
      if (!isRunEventName(event)) {
        problems.push(`dropped unknown run event '${event}'`);
        return;
      }
      chain = chain.then(() => store.appendEvent(runId, event, data)).catch((e: unknown) => {
        problems.push(`run_events write failed for '${event}': ${(e as Error)?.message ?? String(e)}`);
      });
    },
    async drained() {
      await chain.catch(() => undefined);
    },
    problems: () => [...problems],
  };
}
