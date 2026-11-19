/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    How a run ended — one truthful word, the same at every door
 * USER STORY: As the person who started a run I want a run whose agent failed to read "failed"
 *             in the job queue, in `get_agent_run`, in the run report and in the UI — never
 *             "done" — so I do not have to open the steps to learn that it did not work.
 * ARCHITECTURE:
 *   - Pure. `runOutcomeOf` names the outcome of a run that has stopped; `reportedJobStatus`
 *     is the `status` an MCP client reads. Both are derived from the run's own state (what the
 *     graph recorded), so they agree with each other and survive a job row written by an older
 *     version, which settled a failed run as `done`.
 */

/** How a run that has stopped ended. */
export type RunOutcome =
  /** Every agent finished and the graph reached its end. */
  | 'done'
  /** An agent failed (the model call, a refusal, an invalid reply) and the run stopped there. */
  | 'failed'
  /** Waiting on a person's decision about a held write. */
  | 'parked'
  /** Stopped before the end by a restart, an abort or the recursion limit — resumable. */
  | 'interrupted'
  /** Stopped at the step budget: it neither failed nor finished. */
  | 'incomplete';

export function runOutcomeOf(r: { parked: boolean; failed: boolean; interrupted: boolean; reachedEnd: boolean }): RunOutcome {
  if (r.parked) return 'parked';
  if (r.failed) return 'failed';
  if (r.interrupted) return 'interrupted';
  return r.reachedEnd ? 'done' : 'incomplete';
}

/** The job-queue vocabulary (`run_jobs.status`). */
type JobStatus = 'queued' | 'running' | 'parked' | 'done' | 'failed';

/**
 * The `status` a reader of one run is told. The job row is the source while the run is queued or
 * running; once the run's own state says it FAILED, that wins — a row an older version settled
 * `done` for a failed run must not keep reading `done`. With no row at all (the job store was
 * unreachable) the run's state still answers what it can.
 */
export function reportedJobStatus(
  jobStatus: string | undefined,
  run: { failed: boolean; parked: boolean; finished: boolean },
): JobStatus | undefined {
  if (run.failed) return 'failed';
  if (jobStatus === 'queued' || jobStatus === 'running' || jobStatus === 'parked' || jobStatus === 'done' || jobStatus === 'failed') return jobStatus;
  if (run.parked) return 'parked';
  return run.finished ? 'done' : undefined;
}
