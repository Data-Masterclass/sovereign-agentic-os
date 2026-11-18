/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The re-index job table — one running job per target, resumable by cursor
 * USER STORY: As a platform admin I must not be able to start two re-indexes over the same
 *             corpus, and an interrupted run must resume where it stopped rather than from zero.
 * ARCHITECTURE:
 *   - Pure unit test over `core/kernel/reindex.ts`: no network, no OpenSearch, no tab imports.
 *   - The invariant under test is the one the two doors (the route and the MCP tool) rely on, so
 *     it is asserted here once rather than twice in each door's own suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REINDEX_TARGETS,
  REINDEX_FILTERS,
  REINDEX_REASONS,
  UNMARKED_CAVEAT,
  assertReindexAdmin,
  isReindexFilter,
  isReindexTarget,
  zeroCounts,
  startOrResume,
  recordUnit,
  finishJob,
  jobFor,
  jobRemaining,
  allReindexJobs,
  batchSize,
  DEFAULT_REINDEX_BATCH,
  MAX_REINDEX_BATCH,
  MAX_RECORDED_FAILURES,
  __resetReindexJobs,
} from '@core/kernel/reindex';

const ADMIN = { id: 'u_admin', domains: ['d'], role: 'admin' as const };

function reset(): void {
  __resetReindexJobs();
}

test('REINDEX: the vocabulary is closed and the guards reject anything else', () => {
  assert.deepEqual([...REINDEX_TARGETS], ['files', 'knowledge']);
  assert.deepEqual([...REINDEX_FILTERS], ['marked', 'all']);
  assert.ok(isReindexTarget('files') && isReindexTarget('knowledge'));
  assert.ok(!isReindexTarget('metrics') && !isReindexTarget('') && !isReindexTarget(7));
  assert.ok(isReindexFilter('marked') && isReindexFilter('all'));
  assert.ok(!isReindexFilter('MARKED') && !isReindexFilter(undefined));
});

test('REINDEX: every reason is reported, including the ones that are genuinely zero', () => {
  const counts = zeroCounts();
  assert.deepEqual(Object.keys(counts).sort(), [...REINDEX_REASONS].sort());
  for (const r of REINDEX_REASONS) assert.equal(counts[r], 0, `${r} must be present, not omitted`);
});

test('REINDEX: the unmarked caveat says the two things an operator must not mis-read', () => {
  assert.match(UNMARKED_CAVEAT, /cannot be found by filter ‘marked’/);
  assert.match(UNMARKED_CAVEAT, /not a clean bill/);
});

test('REINDEX: admin-only — 403 for every lower role, 401 with no identity', () => {
  assert.doesNotThrow(() => assertReindexAdmin(ADMIN));
  for (const role of ['creator', 'builder', 'domain_admin'] as const) {
    assert.throws(
      () => assertReindexAdmin({ id: 'u1', domains: ['d'], role }),
      (e: Error & { status?: number }) => e.status === 403 && /admin-only/.test(e.message),
      `${role} must not be able to re-index a corpus`,
    );
  }
  assert.throws(
    () => assertReindexAdmin(null),
    (e: Error & { status?: number }) => e.status === 401,
  );
  assert.throws(
    () => assertReindexAdmin({ id: '', domains: [], role: 'admin' }),
    (e: Error & { status?: number }) => e.status === 401,
  );
});

test('REINDEX: one running job per target — a second start reports progress, never a twin', () => {
  reset();
  const first = startOrResume('files', { filter: 'marked', by: 'u_admin', total: 10 });
  assert.equal(first.started, true);
  recordUnit('files', 'replaced');
  recordUnit('files', 'replaced');

  const second = startOrResume('files', { filter: 'all', by: 'u_other', total: 999 });
  assert.equal(second.started, false, 'a second start must not start a second run');
  assert.equal(second.job.id, first.job.id, 'it reports the RUNNING job');
  assert.equal(second.job.cursor, 2, 'with its real progress');
  assert.equal(second.job.total, 10, 'and the running job’s own total, not the new request’s');
  assert.equal(allReindexJobs().filter((j) => j.target === 'files').length, 1);
});

test('REINDEX: the two targets are independent — Files and Knowledge may run together', () => {
  reset();
  const f = startOrResume('files', { filter: 'marked', by: 'u_admin', total: 3 });
  const k = startOrResume('knowledge', { filter: 'all', by: 'u_admin', total: 5 });
  assert.ok(f.started && k.started);
  assert.notEqual(f.job.id, k.job.id);
  recordUnit('files', 'replaced');
  assert.equal(jobFor('files')?.cursor, 1);
  assert.equal(jobFor('knowledge')?.cursor, 0, 'the knowledge job is untouched');
});

test('REINDEX: the cursor is the resume point and advances on a failure too', () => {
  reset();
  startOrResume('files', { filter: 'marked', by: 'u_admin', total: 4 });
  recordUnit('files', 'replaced');
  recordUnit('files', 'failed', { unit: 'f_2', reason: 'docling returned nothing usable' });
  recordUnit('files', 'skipped');
  const job = jobFor('files')!;
  assert.equal(job.cursor, 3, 'a failed unit still advances the cursor — else a bad row loops forever');
  assert.equal(job.replaced, 1);
  assert.equal(job.failed, 1);
  assert.equal(job.skipped, 1);
  assert.equal(jobRemaining(job), 1);
  assert.deepEqual(job.failures, [{ unit: 'f_2', reason: 'docling returned nothing usable' }]);
});

test('REINDEX: a finished job frees the slot; a new run starts fresh at cursor 0', () => {
  reset();
  startOrResume('files', { filter: 'marked', by: 'u_admin', total: 2 });
  recordUnit('files', 'replaced');
  recordUnit('files', 'replaced');
  const done = finishJob('files', 'done');
  assert.equal(done?.status, 'done');
  assert.ok(done?.finishedAt, 'a finished job records when');
  assert.equal(done?.error, null);

  const next = startOrResume('files', { filter: 'all', by: 'u_admin', total: 7 });
  assert.equal(next.started, true, 'the slot is free once the job finished');
  assert.equal(next.job.cursor, 0);
  assert.equal(next.job.filter, 'all');
});

test('REINDEX: a job that STOPPED carries its own error, separate from a unit that failed', () => {
  reset();
  startOrResume('knowledge', { filter: 'marked', by: 'u_admin', total: 9 });
  recordUnit('knowledge', 'failed', { unit: 'wf_1', reason: 'opensearch write did not land' });
  const failed = finishJob('knowledge', 'failed', 'ENGINE_UNAVAILABLE: the embeddings gateway went away');
  assert.equal(failed?.status, 'failed');
  assert.match(failed!.error!, /ENGINE_UNAVAILABLE/);
  assert.equal(failed?.failures.length, 1, 'the unit failure is still its own record');
  assert.equal(failed?.cursor, 1, 'and the cursor stays where the work stopped, so a resume is possible');
});

test('REINDEX: recording against no running job is a no-op, never a crash', () => {
  reset();
  assert.equal(recordUnit('files', 'replaced'), null);
  startOrResume('files', { filter: 'marked', by: 'u_admin', total: 1 });
  finishJob('files', 'done');
  assert.equal(recordUnit('files', 'replaced'), null, 'a late progress report cannot revive a finished job');
  assert.equal(jobFor('files')?.replaced, 0);
});

test('REINDEX: the failure list is capped so a corpus-wide disaster cannot exhaust memory', () => {
  reset();
  startOrResume('files', { filter: 'all', by: 'u_admin', total: 500 });
  for (let i = 0; i < MAX_RECORDED_FAILURES + 25; i++) {
    recordUnit('files', 'failed', { unit: `f_${i}`, reason: 'parser unreachable' });
  }
  const job = jobFor('files')!;
  assert.equal(job.failures.length, MAX_RECORDED_FAILURES);
  assert.equal(job.failed, MAX_RECORDED_FAILURES + 25, 'the COUNT is still complete');
});

test('REINDEX: the batch is bounded, defaulted and never zero', () => {
  assert.equal(batchSize(undefined), DEFAULT_REINDEX_BATCH);
  assert.equal(batchSize(0), DEFAULT_REINDEX_BATCH);
  assert.equal(batchSize(-5), DEFAULT_REINDEX_BATCH);
  assert.equal(batchSize(Number.NaN), DEFAULT_REINDEX_BATCH);
  assert.equal(batchSize(10), 10);
  assert.equal(batchSize(10.9), 10);
  assert.equal(batchSize(100000), MAX_REINDEX_BATCH);
});
