/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Bounded retention for `run_jobs`, `run_events` and the LangGraph checkpoints
 * USER STORY: As an operator I want the `agent_runs` database to stop growing forever: a run that
 *             finished a month ago should take no disk, and a run still PARKED on an approval must
 *             survive however long the approver takes — because deleting it would destroy the only
 *             thing that can resume it.
 * ARCHITECTURE:
 *   - The A13 follow-up: a checkpoint holds the run's raw tool results (the exemption Langfuse's
 *     redaction note recorded), and `run_events` holds the same payloads as a stream. Neither had a
 *     bound. `AGENT_RUNS_RETENTION_DAYS` (default 30, `0` = keep forever) is the one knob.
 *   - PURE and injected: the store, the checkpointer, the clock and the logger are parameters, so
 *     the whole policy — what is eligible, what is spared, what a partial failure does — is tested
 *     with the in-memory store and a fake saver, with no database and no timer.
 *   - The WINDOW itself (`parseRetentionDays` / `retentionCutoff`) lives in
 *     `@core/kernel/agent-run-retention`, because `core/kernel/config.ts` reads the env var and the
 *     kernel must not import a tab — the same split `agents-worker.ts` uses for `AGENTS_WORKER`.
 *   - THREE deletes per run and the ORDER matters: the checkpoint FIRST (it is the big one and the
 *     only one holding raw tool output), then `run_events`, then the `run_jobs` row. A failure part
 *     way through leaves the job row in place, so the NEXT sweep retries that run instead of
 *     orphaning its rows — which is why `deleteRuns` is called per run, not for the whole batch.
 *   - `parked` is never eligible. The store enforces it (`RETAINABLE_STATUSES` is in the SQL) AND
 *     the sweep re-checks the row it is about to delete, because this is the rule whose breach is
 *     unrecoverable: a parked run's checkpoint IS the run.
 *   - BOUNDED per sweep (`batch`), so one sweep can never hold a long transaction or starve the
 *     claim loop; a backlog drains over successive sweeps.
 */
import { RETAINABLE_STATUSES, type RunJobStore } from '@tabs/agents/lib/engine/jobs';
import { retentionCutoff } from '@core/kernel/agent-run-retention';

/** Runs deleted per sweep. One sweep stays short; a backlog drains over the following sweeps. */
export const DEFAULT_RETENTION_BATCH = 200;
/** How often the worker loop sweeps. Retention is a background chore, not a deadline. */
export const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000;

/** Only what retention needs of a checkpointer — so a test passes a 3-line fake. */
export type ThreadDeleter = { deleteThread(threadId: string): Promise<void> };

export type RetentionDeps = {
  store: RunJobStore;
  /** The checkpoint saver. `null` when there is none to clean (then only the two tables are swept). */
  checkpointer: ThreadDeleter | null;
  days: number;
  batch?: number;
  now?: () => number;
  log?: (message: string) => void;
};

export type RetentionOutcome = {
  /** False when the window is 0 (retention off) — nothing was looked at. */
  ran: boolean;
  /** Runs fully deleted (checkpoint + events + job row). */
  deleted: number;
  jobRows: number;
  eventRows: number;
  checkpoints: number;
  /** Runs this sweep could not finish; they stay eligible and the next sweep retries them. */
  failed: number;
  /** True when the batch was full — a backlog remains and the next sweep continues it. */
  more: boolean;
};

const EMPTY: RetentionOutcome = { ran: false, deleted: 0, jobRows: 0, eventRows: 0, checkpoints: 0, failed: 0, more: false };

/**
 * One retention sweep. Never throws: retention is a chore that must not take down the worker loop
 * or the boot path, so every failure is counted, logged and retried by the next sweep.
 */
export async function sweepRetention(deps: RetentionDeps): Promise<RetentionOutcome> {
  const now = (deps.now ?? Date.now)();
  const cutoff = retentionCutoff(now, deps.days);
  if (cutoff === null) return { ...EMPTY };
  const batch = Math.max(1, deps.batch ?? DEFAULT_RETENTION_BATCH);

  let candidates: string[];
  try {
    candidates = await deps.store.settledBefore(cutoff, batch);
  } catch (e) {
    deps.log?.(`retention: could not list expired runs: ${(e as Error)?.message ?? String(e)}`);
    return { ...EMPTY, ran: true };
  }

  const out: RetentionOutcome = { ...EMPTY, ran: true, more: candidates.length >= batch };
  for (const runId of candidates) {
    try {
      // Re-read the row. The listing is a snapshot; between it and this delete the run may have
      // been RESUMED (a parked run decided, a failed run retried), and deleting the checkpoint of
      // a live run would destroy it. This is the one check worth paying a read for.
      const job = await deps.store.get(runId);
      if (!job || !RETAINABLE_STATUSES.includes(job.status)) {
        deps.log?.(`retention: skipping run ${runId} — it is ${job ? job.status : 'gone'}, not an expired settled run`);
        continue;
      }
      // The checkpoint first: it is the largest object and the only one holding raw tool output.
      if (deps.checkpointer) {
        await deps.checkpointer.deleteThread(runId); // thread id === run id (engine/run.ts)
        out.checkpoints += 1;
      }
      const { jobs, events } = await deps.store.deleteRuns([runId]);
      out.jobRows += jobs;
      out.eventRows += events;
      out.deleted += 1;
    } catch (e) {
      // The job row is still there, so this run stays eligible and the next sweep retries it.
      out.failed += 1;
      deps.log?.(`retention: run ${runId} not fully deleted (it stays eligible): ${(e as Error)?.message ?? String(e)}`);
    }
  }

  if (out.deleted > 0 || out.failed > 0) {
    deps.log?.(
      `retention: removed ${out.deleted} run(s) settled before ${new Date(cutoff).toISOString()} ` +
        `(${out.jobRows} job row(s), ${out.eventRows} event row(s), ${out.checkpoints} checkpoint thread(s)` +
        `${out.failed ? `, ${out.failed} deferred` : ''})${out.more ? ' — more remain, the next sweep continues' : ''}`,
    );
  }
  return out;
}
