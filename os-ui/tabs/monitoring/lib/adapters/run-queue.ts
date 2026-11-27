/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The agent-run queue for Monitoring → Platform → Capacity: how many runs wait, how long
 *             the oldest has waited, and the last hour's p95 wait-to-start and p95 run duration.
 * USER STORY: As a platform admin I want to see that runs are queueing — measured by the database
 *             that holds them — before a class tells me agents "do not work".
 * ARCHITECTURE:
 *   - Reads the agent engine's own run store (`run_jobs` + `run_events`, schema in
 *     tabs/agents/lib/engine/jobs-postgres.ts) through the structural `SqlClient` port, ADMIN scope
 *     (every run, counts only — no run content leaves the database). Postgres does the arithmetic
 *     (`percentile_cont`), so the numbers are the store's, not a sample.
 *   - Oldest wait: `now - updated_at` of the oldest `queued` row — `updated_at` is when it was queued
 *     or re-queued (a resume re-queues the SAME row and keeps the original `created_at`).
 *   - Wait-to-start: first `run_events.at` − `created_at`, for runs whose first event is in the window.
 *   - Run duration: `updated_at` − first event, for runs that ended `done`/`failed` in the window on
 *     their first pass (`kind = 'start'`; a parked-then-resumed run would count its approval wait).
 *   - Read-only; an error propagates to the caller, which reports the source `unavailable`.
 */
import type { RunQueue } from '@tabs/monitoring/lib/capacity-core';

/** The query surface of a `pg` Pool/Client. */
export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

export const QUEUE_NOW_SQL = `
  SELECT count(*) FILTER (WHERE status = 'queued')::int  AS queued,
         count(*) FILTER (WHERE status = 'running')::int AS running,
         EXTRACT(EPOCH FROM ($1::timestamptz - min(updated_at) FILTER (WHERE status = 'queued')))::float8 AS oldest_wait
    FROM run_jobs
   WHERE status IN ('queued', 'running')`;

export const QUEUE_HOUR_SQL = `
  WITH f AS (
    SELECT j.kind, j.status, j.created_at, j.updated_at,
           (SELECT e.at FROM run_events e WHERE e.run_id = j.run_id ORDER BY e.seq LIMIT 1) AS first_at
      FROM run_jobs j
     WHERE j.updated_at >= $1
  )
  SELECT count(*) FILTER (WHERE first_at >= $1)::int AS started,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_at - created_at)))
           FILTER (WHERE first_at >= $1) AS p95_wait,
         count(*) FILTER (WHERE status IN ('done', 'failed') AND kind = 'start' AND first_at IS NOT NULL)::int AS finished,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - first_at)))
           FILTER (WHERE status IN ('done', 'failed') AND kind = 'start' AND first_at IS NOT NULL) AS p95_run
    FROM f`;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : null;
};

export async function readRunQueue(sql: SqlClient, nowMs: number): Promise<RunQueue> {
  const now = new Date(nowMs);
  const since = new Date(nowMs - 3_600_000);
  const [a, b] = await Promise.all([sql.query(QUEUE_NOW_SQL, [now]), sql.query(QUEUE_HOUR_SQL, [since])]);
  const r = a.rows[0] ?? {};
  const h = b.rows[0] ?? {};
  return {
    queued: num(r.queued) ?? 0,
    running: num(r.running) ?? 0,
    oldestQueuedWaitSec: num(r.oldest_wait),
    startedLastHour: num(h.started) ?? 0,
    p95StartWaitSec: num(h.p95_wait),
    finishedLastHour: num(h.finished) ?? 0,
    p95RunSec: num(h.p95_run),
  };
}
