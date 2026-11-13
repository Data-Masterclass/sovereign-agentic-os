/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 review H-2 / M-1 / M-2 / M-5 / L-3 / L-6 — leases, reaping, races and ceilings
 * USER STORY: As an operator I want the queue's hard edges tested without a database: a worker that
 *             lost its lease stops instead of racing the pod that took over, a stale holder cannot
 *             settle somebody else's run, a pod that died mid-run is picked up again (and RE-STARTED
 *             when it never got a checkpoint), a decision that lands while the run is still parking
 *             is honoured, a tail never hangs on a settled run, and one pod refuses the 65th tail
 *             rather than starving its connection pool.
 * ARCHITECTURE: All pure: `engine/worker-loop.ts` (`leaseWatch`, `settlementOf`),
 *             `engine/jobs.ts` (the lease-guarded `complete`, `reapStale`, `enqueueResumeWithRetry`,
 *             `tailRunEvents`), `engine/tail-limit.ts`, plus two SOURCE tripwires for the wiring in
 *             the `server-only` module a unit test must not import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leaseWatch, settlementOf } from '@tabs/agents/lib/engine/worker-loop';
import { enqueueResumeWithRetry, memoryRunJobStore, tailRunEvents, type NewRunJob } from '@tabs/agents/lib/engine/jobs';
import { postgresRunJobStore, type SqlClient } from '@tabs/agents/lib/engine/jobs-postgres';
import { acquireTail, MAX_CONCURRENT_TAILS, resetTails, TooManyTailsError } from '@tabs/agents/lib/engine/tail-limit';

const JOB: NewRunJob = {
  runId: 'r1', systemId: 'sys-1', domain: 'sales', requestedBy: 'u1',
  principal: { id: 'u1', name: 'Ada', role: 'builder', domains: ['sales'], activeDomain: null },
  input: { messages: [{ role: 'user', content: 'go' }], prompt: 'go' }, kind: 'start',
};

// ----------------------------------------------------------------- H-2 --

test('H-2: a heartbeat that reports a lost lease aborts the run — once, and not on a DB blip', async () => {
  const aborted: string[] = [];
  let answer: 'ok' | 'lost' | 'throw' = 'ok';
  const watch = leaseWatch({
    heartbeat: async () => {
      if (answer === 'throw') throw new Error('connection terminated');
      return answer === 'ok';
    },
    onLost: (reason) => aborted.push(reason),
  });

  await watch.tick();
  assert.equal(watch.lost(), false);
  answer = 'throw';
  await watch.tick();
  assert.equal(watch.lost(), false, 'a failed heartbeat QUERY says nothing about the lease');
  assert.deepEqual(aborted, []);
  answer = 'lost';
  await watch.tick();
  assert.equal(watch.lost(), true);
  assert.equal(aborted.length, 1);
  await watch.tick();
  assert.equal(aborted.length, 1, 'the abort fires once, not every beat');
});

test('H-2: a lost lease is abandoned — never settled, never re-queued', () => {
  assert.deepEqual(settlementOf({ leaseLost: true, stopping: false, parked: false, reachedEnd: true }).kind, 'abandon');
  assert.deepEqual(settlementOf({ leaseLost: true, stopping: true, failure: 'boom' }).kind, 'abandon', 'abandon beats both a failure and a shutdown');
  assert.deepEqual(settlementOf({ leaseLost: false, stopping: false, failure: 'boom' }), { kind: 'complete', status: 'failed', error: 'boom' });
  assert.deepEqual(settlementOf({ leaseLost: false, stopping: true, parked: false, reachedEnd: false }), { kind: 'requeue' });
  assert.deepEqual(settlementOf({ leaseLost: false, stopping: true, parked: true, reachedEnd: false }), { kind: 'complete', status: 'parked' }, 'a parked run is parked even under SIGTERM');
  assert.deepEqual(settlementOf({ leaseLost: false, stopping: false, parked: false, reachedEnd: true }), { kind: 'complete', status: 'done' });
});

test('H-2: a stale holder cannot settle a run another worker re-claimed', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB);
  await store.claimById('r1', 'worker-a');
  // The reaper takes it and worker-b claims it.
  await store.reapStale({ olderThanMs: 0, maxAttempts: 5, now: Date.now() + 1 });
  const reclaimed = await store.claimById('r1', 'worker-b');
  assert.equal(reclaimed?.lockedBy, 'worker-b');

  assert.equal(await store.complete('r1', 'done', { lockedBy: 'worker-a' }), false, 'the stale settle is a no-op');
  assert.equal((await store.get('r1'))?.status, 'running', 'the run still belongs to the new holder');
  assert.equal(await store.complete('r1', 'done', { lockedBy: 'worker-b' }), true);
  assert.equal((await store.get('r1'))?.status, 'done');
});

test('H-2 SQL: complete is lease-guarded only when a holder is named', async () => {
  const sql: string[] = [];
  const db: SqlClient = { async query(text) { sql.push(text); return { rows: [], rowCount: 1 }; } };
  const store = postgresRunJobStore(db);
  await store.complete('r1', 'done', { lockedBy: 'worker-a' });
  assert.match(sql[0], /AND locked_by=\$5 AND status='running'/, 'a named holder must still hold a running lease');
  await store.complete('r1', 'done');
  assert.doesNotMatch(sql[1], /locked_by=\$/, 'the reaper/backstop path stays unguarded on purpose');
});

// ----------------------------------------------------- M-1 + M-5 (reap) --

test('M-1 + M-5: one sweep re-queues the run of a pod that died, and a reaped START stays a start', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB, 1_000);
  await store.claimById('r1', 'dead-pod', 1_000);
  // The boot sweep of the NEXT pod, one lease later.
  const out = await store.reapStale({ olderThanMs: 600_000, maxAttempts: 2, now: 700_000 });
  assert.deepEqual(out, { requeued: ['r1'], failed: [] });
  const row = await store.get('r1');
  assert.equal(row?.status, 'queued');
  assert.equal(row?.kind, 'start', 'a run killed before its first checkpoint has nothing to resume FROM');
  assert.equal(row?.lockedBy, null);

  // A row that WAS a resume stays a resume; the second expiry fails it visibly.
  await store.claimById('r1', 'dead-pod-2', 700_000);
  const second = await store.reapStale({ olderThanMs: 600_000, maxAttempts: 2, now: 1_400_000 });
  assert.deepEqual(second.failed, ['r1'], 'attempt 2 is the last — then a visible failure, never `running` forever');
});

test('M-5 SQL: the reap preserves kind=start and only downgrades a resume', async () => {
  const sql: string[] = [];
  const db: SqlClient = { async query(text) { sql.push(text); return { rows: [], rowCount: 0 }; } };
  await postgresRunJobStore(db).reapStale({ olderThanMs: 1, maxAttempts: 2 });
  assert.match(sql[0], /kind=CASE WHEN kind='start' THEN 'start' ELSE 'resume' END/);
});

test('M-1: ensureRunJobsReady runs the boot sweep (source tripwire)', () => {
  const src = readFileSync(new URL('../build/run-jobs-server.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function ensureRunJobsReady'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /reapStaleOnce\(store\)/, 'inline mode has no worker loop — boot is the only reaper it gets');
  assert.match(src, /startLeaseKeeper\(store, runId, id, \(\) => abort\.abort\(\), log\)/, 'inline runs heartbeat under the same lease');
});

// ------------------------------------------------------------------ M-2 --

test('M-2: a decision that lands while the run is still PARKING is retried, not failed', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB);
  await store.claimById('r1', 'worker-a'); // status: running — the run is mid-`interrupt()`
  const naps: number[] = [];
  const resume: NewRunJob = { ...JOB, kind: 'resume', input: { messages: [] } };

  const filed = await enqueueResumeWithRetry(store, resume, {
    attempts: 5,
    delayMs: 200,
    sleep: async (ms) => {
      naps.push(ms);
      // The executor finishes parking between the first and the second attempt.
      if (naps.length === 1) await store.complete('r1', 'parked', { lockedBy: 'worker-a' });
    },
  });
  assert.equal(filed.status, 'queued');
  assert.equal(filed.kind, 'resume');
  assert.deepEqual(naps, [200], 'one short nap, not a failed approval');
});

test('M-2: a genuinely queued run is NOT retried — that conflict is real', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB); // queued, never claimed
  const naps: number[] = [];
  await assert.rejects(() => enqueueResumeWithRetry(store, { ...JOB, kind: 'resume' }, { attempts: 3, sleep: async (ms) => { naps.push(ms); } }));
  assert.deepEqual(naps, [], 'only a `running` row is worth waiting for');
});

test('M-2: a row that never parks exhausts the attempts and surfaces the 409', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB);
  await store.claimById('r1', 'worker-a');
  let naps = 0;
  await assert.rejects(
    () => enqueueResumeWithRetry(store, { ...JOB, kind: 'resume' }, { attempts: 3, sleep: async () => { naps += 1; } }),
    (e: unknown) => (e as { status?: number }).status === 409,
  );
  assert.equal(naps, 2, 'three attempts = two naps');
});

// ------------------------------------------------------------------ L-3 --

test('L-3: a terminal tail ends on a settled run with no terminal event — but NOT on a parked one', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(JOB);
  await store.claimById('r1', 'w1');
  await store.appendEvent('r1', 'approval-required', { approvalId: 'a1' });
  await store.complete('r1', 'parked', { lockedBy: 'w1' });

  const parkedSeen: string[] = [];
  const parked = await tailRunEvents(store, 'r1', { until: 'terminal', afterSeq: 0, pollMs: 1, timeoutMs: 30 }, (ev) => parkedSeen.push(ev.event));
  assert.deepEqual(parkedSeen, ['approval-required']);
  assert.equal(parked.ended, 'timeout', 'a parked run keeps the re-attach stream open for the decision');

  // The same run, now finished WITHOUT a terminal event (a crash between the event and the status).
  await store.enqueue({ ...JOB, kind: 'resume', input: { messages: [] } });
  await store.claimById('r1', 'w1');
  await store.complete('r1', 'done', { lockedBy: 'w1' });
  const out = await tailRunEvents(store, 'r1', { until: 'terminal', afterSeq: 1, pollMs: 1, timeoutMs: 2_000 }, () => undefined);
  assert.equal(out.ended, 'settled', 'a settled-and-finished run must never hang the tail');
});

// ------------------------------------------------------------------ L-6 --

test('L-6: a pod holds at most MAX_CONCURRENT_TAILS tails and refuses the next with 503', () => {
  resetTails();
  const releases = Array.from({ length: MAX_CONCURRENT_TAILS }, () => acquireTail());
  assert.throws(() => acquireTail(), (e: unknown) => {
    assert.ok(e instanceof TooManyTailsError);
    assert.equal(e.status, 503);
    assert.equal(e.retryAfterSeconds, 5);
    return true;
  });
  releases[0]();
  releases[0](); // idempotent: a double release must not inflate the budget
  const again = acquireTail();
  assert.throws(() => acquireTail());
  again();
  resetTails();
});
