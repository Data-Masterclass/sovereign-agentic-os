/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Is this run MINE? — the one visibility gate every run-id door shares
 * USER STORY: As a builder I must not be able to replay, re-queue or watch somebody else's run by
 *             guessing its id: a foreign run id, or one belonging to a different system, answers
 *             404 — the same answer a run that does not exist gives, so the id itself leaks nothing.
 * ARCHITECTURE:
 *   - PURE and dependency-free (not even the job types: it takes the two fields it compares), so
 *     every door can call it BEFORE any side effect — the run route before `enqueueRun`, the
 *     re-attach stream before it tails, the MCP `resume_agent_run` before it files a resume.
 *   - 404-SEMANTICS, never 403: "No run with this id for you" is the only safe answer. A 403 would
 *     confirm that the run exists and belongs to someone else.
 *   - A4 review H-1: the owner gate used to live INSIDE the engine (`engine/run.ts`
 *     `assertResumable`), which fires only after the job has been enqueued and the history has
 *     already streamed back. The gate therefore has to exist at the door as well, and the store's
 *     `enqueue(kind:'resume')` refuses a mismatched `requested_by` as defence in depth.
 */

/** The two fields a visibility decision needs — a `run_jobs` row, or a checkpoint's owner. */
export type RunOwnerRecord = { requestedBy: string; systemId: string };

/** A run that is not the caller's (or not this system's) — reported as 404, never 403. */
export class RunNotVisibleError extends Error {
  runId: string;
  status: number;
  constructor(runId: string) {
    super(`No run '${runId}' for you — it does not exist, or it is not yours`);
    this.name = 'RunNotVisibleError';
    this.runId = runId;
    this.status = 404;
  }
}

/**
 * Return `record` when it is the caller's run (and, when `systemId` is given, this system's run);
 * throw {@link RunNotVisibleError} otherwise — including when there is no record at all.
 */
export function assertRunVisible<T extends RunOwnerRecord>(
  record: T | null | undefined,
  runId: string,
  userId: string,
  systemId?: string | null,
): T {
  if (!record) throw new RunNotVisibleError(runId);
  if (record.requestedBy !== userId) throw new RunNotVisibleError(runId);
  if (systemId && record.systemId !== systemId) throw new RunNotVisibleError(runId);
  return record;
}
