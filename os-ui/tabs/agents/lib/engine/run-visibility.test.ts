/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 review H-1 — a run id is not an authorisation
 * USER STORY: As a security reviewer I want a guessed run id to be worth nothing: every door
 *             answers 404 for a run that is not the caller's, no row is touched on the way, and the
 *             store refuses a foreign resume even if a future door forgets to ask.
 * ARCHITECTURE: The pure gate (`assertRunVisible`) plus both store implementations — the in-memory
 *             one behaviourally, the Postgres one on its SQL (the `requested_by` predicate IS the
 *             guarantee that nothing is overwritten before the refusal).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRunVisible, RunNotVisibleError } from '@tabs/agents/lib/engine/run-visibility';
import { memoryRunJobStore, RunJobConflictError, type NewRunJob } from '@tabs/agents/lib/engine/jobs';
import { postgresRunJobStore, type SqlClient } from '@tabs/agents/lib/engine/jobs-postgres';

const JOB: NewRunJob = {
  runId: 'r1', systemId: 'sys-1', domain: 'sales', requestedBy: 'u1',
  principal: { id: 'u1', name: 'Ada', role: 'builder', domains: ['sales'], activeDomain: null },
  input: { messages: [{ role: 'user', content: 'go' }], prompt: 'go' }, kind: 'start',
};

test('H-1: the gate answers 404 for a missing, foreign or wrong-system run and passes the owner', () => {
  const row = { requestedBy: 'u1', systemId: 'sys-1' };
  assert.equal(assertRunVisible(row, 'r1', 'u1', 'sys-1'), row, 'the owner sees their own run');
  assert.equal(assertRunVisible(row, 'r1', 'u1'), row, 'no system constraint given = owner check only');
  for (const [record, user, system] of [
    [null, 'u1', 'sys-1'],
    [row, 'u2', 'sys-1'],
    [row, 'u1', 'sys-2'],
  ] as const) {
    assert.throws(() => assertRunVisible(record, 'r1', user, system), (e: unknown) => {
      assert.ok(e instanceof RunNotVisibleError);
      assert.equal(e.status, 404, 'never 403 — a 403 confirms the run exists');
      return true;
    });
  }
});

test('H-1: the memory store refuses a foreign resume and does NOT mutate the row', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB);
  await store.claimById('r1', 'w1');
  await store.complete('r1', 'parked', { lockedBy: 'w1' });
  const before = await store.get('r1');

  await assert.rejects(
    () => store.enqueue({ ...JOB, kind: 'resume', requestedBy: 'attacker', principal: { ...JOB.principal, id: 'attacker' }, input: { messages: [] } }),
    (e: unknown) => e instanceof RunNotVisibleError && (e as RunNotVisibleError).status === 404,
  );
  const after = await store.get('r1');
  assert.deepEqual(after, before, 'requested_by / principal / input / status are untouched by a refused resume');

  // The owner may still resume it — the refusal is about identity, not about the row's state.
  const resumed = await store.enqueue({ ...JOB, kind: 'resume', input: { messages: [] } });
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.requestedBy, 'u1');
});

test('H-1: a resume of a run that is queued or running is still a 409, not a 404', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB);
  await assert.rejects(
    () => store.enqueue({ ...JOB, kind: 'resume' }),
    (e: unknown) => e instanceof RunJobConflictError && (e as RunJobConflictError).state === 'queued',
  );
});

test('H-1 SQL: the resume UPDATE is scoped by requested_by and never rewrites it', async () => {
  const sql: string[] = [];
  const args: unknown[][] = [];
  const db: SqlClient = {
    async query(text, values) {
      sql.push(text);
      args.push(values ?? []);
      // The UPDATE matches nothing (a foreign resume), then the SELECT returns someone else's row.
      if (/^UPDATE run_jobs/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [{ run_id: 'r1', system_id: 'sys-1', domain: 'sales', requested_by: 'u1', principal_snapshot: {}, input: {}, kind: 'start', status: 'parked', locked_by: null, locked_at: null, attempts: 1, error: null, created_at: 1, updated_at: 1 }], rowCount: 1 };
    },
  };
  await assert.rejects(
    () => postgresRunJobStore(db).enqueue({ ...JOB, kind: 'resume', requestedBy: 'attacker' }),
    (e: unknown) => e instanceof RunNotVisibleError,
  );
  const update = sql.find((s) => /^UPDATE run_jobs/.test(s)) ?? '';
  assert.match(update, /WHERE run_id=\$1 AND requested_by=\$2/, 'the predicate is what keeps a foreign resume from writing');
  const setClause = update.slice(update.indexOf('SET'), update.indexOf('WHERE'));
  assert.doesNotMatch(setClause, /requested_by=/, 'a resume must never overwrite who owns the run');
  assert.match(update, /status IN \('parked','done','failed'\)/, 'only a settled row may be re-queued');
});
