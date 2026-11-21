/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Runs over time, failure classes and last failures per agent system, from the run store
 * USER STORY: As an agentic engineer I want each agent system's runs per day (done · failed · held
 *             for approval), why the failed ones failed, and the last failures to open — counted by
 *             the database that holds the runs, inside my scope.
 * ARCHITECTURE:
 *   - Server-side read of the agent engine's own run store (`run_jobs` + the latest `run_events`
 *     `done` frame, tabs/agents/lib/engine/jobs-postgres.ts). Postgres does the counting
 *     (`date_trunc('day')`, `GROUP BY`); the outcome rule is `runListStatusOf` written as SQL, so
 *     the chart and `list_runs` agree.
 *   - Scope is in the WHERE, the same predicate as `listRuns`: `visibleTo` absent = admin (all);
 *     otherwise own runs, or runs of the listed domains.
 *   - Failure classes: `budget_exceeded` is LiteLLM's own error type (and the OS's typed message for
 *     it); every other failure is `other`. Policy denials and approval holds are not run failures —
 *     they come from OPA's decision log (agent-panel.ts).
 */
/** The query surface of a `pg` Pool/Client (structurally the run store's `SqlClient`). */
export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

export type DayCounts = { day: string; done: number; failed: number; held: number; active: number; other: number };
export type RunFailure = { runId: string; at: string; requestedBy: string; node: string | null; reason: string };
export type SystemRunStats = {
  systemId: string;
  days: DayCounts[];
  failureClasses: { budget_exceeded: number; other: number };
  lastFailures: RunFailure[];
};

const BUDGET = `(budget_exceeded|Budget has been exceeded|LLM budget for this key or team is exhausted)`;

const RUNS = `
  WITH r AS (
    SELECT j.run_id, j.system_id, j.requested_by, j.created_at, j.status, j.error,
           d.data AS report
      FROM run_jobs j
      LEFT JOIN LATERAL (
        SELECT e.data FROM run_events e WHERE e.run_id = j.run_id AND e.event = 'done' ORDER BY e.seq DESC LIMIT 1
      ) d ON true
     WHERE j.system_id = ANY($1::text[])
       AND j.created_at >= $2
       AND ($3::text IS NULL OR j.requested_by = $3 OR j.domain = ANY($4::text[]))
  ), o AS (
    SELECT *, CASE
      WHEN status IN ('queued', 'running') THEN 'active'
      WHEN status = 'failed' OR (report->>'failed') = 'true' THEN 'failed'
      WHEN status = 'parked' OR (report->>'parked') = 'true' THEN 'held'
      WHEN (report->>'interrupted') = 'true' OR report->>'status' IN ('interrupted', 'incomplete') OR (report->>'reachedEnd') = 'false' THEN 'other'
      ELSE 'done' END AS outcome,
      COALESCE(report->'failure'->>'reason', error, '') AS reason,
      report->'failure'->>'node' AS node
    FROM r
  )`;

export async function runStats(
  sql: SqlClient,
  q: { systemIds: readonly string[]; since: Date; visibleTo?: { requestedBy: string; domains: readonly string[] }; lastFailures?: number },
): Promise<Map<string, SystemRunStats>> {
  const out = new Map<string, SystemRunStats>();
  if (q.systemIds.length === 0) return out;
  const args = [[...q.systemIds], q.since, q.visibleTo ? q.visibleTo.requestedBy : null, q.visibleTo ? [...q.visibleTo.domains] : []];
  const [days, classes, fails] = await Promise.all([
    sql.query(`${RUNS} SELECT system_id, to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, outcome, count(*)::int AS n FROM o GROUP BY 1, 2, 3 ORDER BY 2`, args),
    sql.query(`${RUNS} SELECT system_id, (reason ~* '${BUDGET}') AS budget, count(*)::int AS n FROM o WHERE outcome = 'failed' GROUP BY 1, 2`, args),
    sql.query(
      `${RUNS} SELECT system_id, run_id, requested_by, node, reason, created_at FROM (
         SELECT *, row_number() OVER (PARTITION BY system_id ORDER BY created_at DESC, run_id DESC) AS rn FROM o WHERE outcome = 'failed'
       ) x WHERE rn <= $5 ORDER BY created_at DESC`,
      [...args, q.lastFailures ?? 5],
    ),
  ]);
  const get = (id: string): SystemRunStats => {
    let s = out.get(id);
    if (!s) out.set(id, (s = { systemId: id, days: [], failureClasses: { budget_exceeded: 0, other: 0 }, lastFailures: [] }));
    return s;
  };
  for (const row of days.rows) {
    const s = get(String(row.system_id));
    const day = String(row.day);
    let d = s.days.find((x) => x.day === day);
    if (!d) s.days.push((d = { day, done: 0, failed: 0, held: 0, active: 0, other: 0 }));
    d[String(row.outcome) as keyof Omit<DayCounts, 'day'>] += Number(row.n);
  }
  for (const row of classes.rows) get(String(row.system_id)).failureClasses[row.budget ? 'budget_exceeded' : 'other'] += Number(row.n);
  for (const row of fails.rows) {
    get(String(row.system_id)).lastFailures.push({
      runId: String(row.run_id),
      at: new Date(row.created_at as string).toISOString(),
      requestedBy: String(row.requested_by),
      node: row.node ? String(row.node) : null,
      reason: String(row.reason ?? '').slice(0, 300),
    });
  }
  return out;
}
