/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 — the SQL tripwires of the `run_jobs` store
 * USER STORY: As a reviewer I cannot run Postgres in this suite, so I want the properties the SQL
 *             must have asserted on the statements themselves: idempotent DDL (several pods boot at
 *             once), `FOR UPDATE SKIP LOCKED` on the claim (two workers never take the same run),
 *             a resume that only re-queues a SETTLED row, and an append that derives `seq` in the
 *             database rather than in a racing process.
 * ARCHITECTURE:
 *   - `postgresRunJobStore` over a recording fake `SqlClient`. This is a tripwire, not a database
 *     test: the behaviour contract is pinned against the in-memory store in `jobs.test.ts`, and
 *     the real SQL is verified in kind (see the A4 cluster steps in `docs/components/os-ui.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresRunJobStore, migrateRunJobs, RUN_JOBS_DDL, type SqlClient } from '@tabs/agents/lib/engine/jobs-postgres';
import { RunJobNotFoundError, type NewRunJob } from '@tabs/agents/lib/engine/jobs';

function recorder(rows: Record<string, unknown>[][] = []): SqlClient & { sql: string[]; args: unknown[][] } {
  const sql: string[] = [];
  const args: unknown[][] = [];
  let i = 0;
  return {
    sql,
    args,
    async query(text, values) {
      sql.push(text);
      args.push(values ?? []);
      const next = rows[i] ?? [];
      i += 1;
      return { rows: next, rowCount: next.length };
    },
  };
}

const JOB: NewRunJob = {
  runId: 'r1', systemId: 'sys-1', domain: 'sales', requestedBy: 'u1',
  principal: { id: 'u1', name: 'Ada', role: 'builder', domains: ['sales'], activeDomain: null },
  input: { messages: [] }, kind: 'start',
};

test('A4 SQL: the DDL is idempotent — several pods can run it at the same boot', async () => {
  for (const stmt of RUN_JOBS_DDL) {
    assert.match(stmt, /IF NOT EXISTS/, `not idempotent: ${stmt.slice(0, 60)}`);
  }
  const db = recorder();
  await migrateRunJobs(db);
  assert.equal(db.sql.length, RUN_JOBS_DDL.length);
  assert.ok(db.sql.some((s) => /run_jobs/.test(s) && /run_id\s+TEXT PRIMARY KEY/.test(s)), 'one row per run');
  assert.ok(db.sql.some((s) => /run_events/.test(s) && /PRIMARY KEY \(run_id, seq\)/.test(s)), 'the tail is a PK range scan');
});

test('A4 SQL: the claim is FOR UPDATE SKIP LOCKED and bumps attempts', async () => {
  const db = recorder([[]]);
  await postgresRunJobStore(db).claim('worker-a');
  const sql = db.sql[0];
  assert.match(sql, /FOR UPDATE SKIP LOCKED/, 'two workers must never block on, or take, the same row');
  assert.match(sql, /status='queued'/);
  assert.match(sql, /attempts=j\.attempts\+1/, 'a claim burns an attempt — that is what caps the retries');
  assert.match(sql, /ORDER BY created_at/, 'oldest first');
  assert.match(sql, /LIMIT 1/);
});

test('A4 SQL: a start inserts atomically; a resume only re-queues a SETTLED row', async () => {
  const start = recorder([[{ run_id: 'r1', system_id: 'sys-1', domain: 'sales', requested_by: 'u1', principal_snapshot: JOB.principal, input: JOB.input, kind: 'start', status: 'queued', attempts: 0, created_at: new Date(0), updated_at: new Date(0) }]]);
  const row = await postgresRunJobStore(start).enqueue(JOB);
  assert.match(start.sql[0], /INSERT INTO run_jobs/);
  assert.match(start.sql[0], /ON CONFLICT \(run_id\) DO NOTHING/, 'two pods cannot both insert the same minted id');
  assert.equal(row.status, 'queued');

  const resume = recorder([[]]);
  await postgresRunJobStore(resume).enqueue({ ...JOB, kind: 'resume' }).catch(() => undefined);
  assert.match(resume.sql[0], /UPDATE run_jobs/);
  assert.match(resume.sql[0], /status IN \('parked','done','failed'\)/, 'a queued/running run must not be re-queued under itself');
});

test('A4 SQL: a resume of a row that is not there is a 404, not a 409', async () => {
  const db = recorder([[], []]); // the UPDATE matches nothing, then the SELECT finds nothing
  await assert.rejects(
    () => postgresRunJobStore(db).enqueue({ ...JOB, kind: 'resume' }),
    (e: unknown) => e instanceof RunJobNotFoundError && (e as RunJobNotFoundError).status === 404,
  );
});

test('A4 SQL: seq is derived in the database, so two writers cannot mint the same one', async () => {
  const db = recorder([[{ run_id: 'r1', seq: 7, event: 'tool-step', data: { tool: 'query_data' }, at: new Date(0) }]]);
  const row = await postgresRunJobStore(db).appendEvent('r1', 'tool-step', { tool: 'query_data' });
  assert.match(db.sql[0], /COALESCE\(MAX\(seq\),0\)\+1/);
  assert.equal(row.seq, 7);
  assert.equal(row.event, 'tool-step');
  assert.deepEqual(row.data, { tool: 'query_data' });
});

test('A4 SQL: a heartbeat renews only the holder’s running lease', async () => {
  const db = recorder([[]]);
  assert.equal(await postgresRunJobStore(db).heartbeat('r1', 'worker-a'), false);
  assert.match(db.sql[0], /locked_by=\$2 AND status='running'/);
});

test('A4 SQL: the reaper re-queues under the attempt cap and fails above it', async () => {
  const db = recorder([[{ run_id: 'r1' }], [{ run_id: 'r2' }]]);
  const out = await postgresRunJobStore(db).reapStale({ olderThanMs: 60_000, maxAttempts: 2, now: 1_000_000 });
  assert.deepEqual(out, { requeued: ['r1'], failed: ['r2'] });
  assert.match(db.sql[0], /attempts < \$2/);
  assert.match(db.sql[0], /kind='resume'/, 'a retry continues the thread from its checkpoint');
  assert.match(db.sql[1], /status='failed'/);
  assert.ok(db.sql.every((s) => /locked_at IS NOT NULL/.test(s)), 'a row with no lease is never reaped');
});

test('A4 SQL: the event vocabulary is enforced before the insert', async () => {
  const db = recorder();
  await assert.rejects(() => postgresRunJobStore(db).appendEvent('r1', 'whatever' as never, {}), /not a run event/);
  assert.deepEqual(db.sql, [], 'nothing reached the database');
});
