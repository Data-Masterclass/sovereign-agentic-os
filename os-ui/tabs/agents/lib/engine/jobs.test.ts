/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 — the run job store contract and the event tail
 * USER STORY: As the engine-rebuild engineer I want proof that a run can be filed once and claimed
 *             once, that a second start or a racing resume is refused with a typed conflict, that a
 *             resume of a run that never existed is a 404 and not a 409, that the event log replays
 *             in order from seq 0 and resumes from any later cursor, that only the SSE vocabulary
 *             reaches the table, and that a job whose worker died is re-queued exactly once and
 *             then fails visibly instead of sitting `running` forever.
 * ARCHITECTURE:
 *   - Against `memoryRunJobStore()`, which is the CONTRACT every implementation must meet (the
 *     Postgres implementation is the same state machine in SQL). Pure: no database, no timers —
 *     every call takes an explicit `now`, so the lease cases are deterministic.
 *   - `tailRunEvents` is what BOTH routes use (POST …/run from seq 0, GET …/run/stream from a
 *     cursor), so testing it here is testing the route's mechanism without importing a route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTerminalEvent,
  memoryRunJobStore,
  RunJobConflictError,
  RunJobNotFoundError,
  runEventSink,
  tailRunEvents,
  type NewRunJob,
  type RunEventRow,
} from '@tabs/agents/lib/engine/jobs';

const PRINCIPAL = { id: 'u1', name: 'Ada', role: 'builder' as const, domains: ['sales'], activeDomain: 'sales' };

function job(runId: string, kind: 'start' | 'resume' = 'start'): NewRunJob {
  return {
    runId,
    systemId: 'sys-1',
    domain: 'sales',
    requestedBy: 'u1',
    principal: PRINCIPAL,
    input: { messages: [{ role: 'user', content: 'go' }], prompt: 'go' },
    kind,
  };
}

test('A4 queue: enqueue → claim → events → done is the whole life of a run', async () => {
  const store = memoryRunJobStore();
  const queued = await store.enqueue(job('r1'), 1_000);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.attempts, 0);

  const claimed = await store.claim('worker-a', 2_000);
  assert.equal(claimed?.runId, 'r1');
  assert.equal(claimed?.status, 'running');
  assert.equal(claimed?.lockedBy, 'worker-a');
  assert.equal(claimed?.attempts, 1, 'a claim counts as an attempt — that is what caps the retries');
  assert.equal(await store.claim('worker-b', 2_100), null, 'a second worker finds nothing to claim');

  await store.appendEvent('r1', 'node-started', { node: 'writer', index: 1 }, 3_000);
  await store.appendEvent('r1', 'tool-step', { tool: 'search_knowledge', status: 'ok' }, 3_100);
  await store.appendEvent('r1', 'done', { ok: true, parked: false }, 3_200);
  await store.complete('r1', 'done', { now: 3_300 });

  const after = await store.get('r1');
  assert.equal(after?.status, 'done');
  assert.equal(after?.lockedBy, null, 'a settled job releases its lock');
  assert.deepEqual((await store.eventsAfter('r1', 0)).map((e) => [e.seq, e.event]), [
    [1, 'node-started'],
    [2, 'tool-step'],
    [3, 'done'],
  ]);
  assert.equal(await store.lastSeq('r1'), 3);
});

test('A4 queue: a second start is a 409; a resume of an unknown run is a 404', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  await assert.rejects(() => store.enqueue(job('r1')), (e: unknown) => e instanceof RunJobConflictError && (e as RunJobConflictError).status === 409);
  await assert.rejects(() => store.enqueue(job('nope', 'resume')), (e: unknown) => e instanceof RunJobNotFoundError && (e as RunJobNotFoundError).status === 404);
});

test('A4 queue: a run that is queued or running cannot be re-queued — the cross-process in-flight lock', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  await assert.rejects(() => store.enqueue(job('r1', 'resume')), RunJobConflictError, 'queued');
  await store.claim('w', 10);
  await assert.rejects(() => store.enqueue(job('r1', 'resume')), RunJobConflictError, 'running');
  await store.complete('r1', 'parked', { now: 20 });
  const resumed = await store.enqueue(job('r1', 'resume'), 30);
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.kind, 'resume');
  assert.equal(resumed.attempts, 0, 'a fresh decision gets a fresh attempt budget');
  assert.equal(resumed.createdAt, (await store.get('r1'))?.createdAt, 'the SAME row — one row per run');
});

test('A4 queue: a stale lease is re-queued ONCE, then failed', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'), 0);
  await store.claim('dead-worker', 1_000);

  // Still inside the lease: nothing is touched.
  assert.deepEqual(await store.reapStale({ olderThanMs: 60_000, maxAttempts: 2, now: 30_000 }), { requeued: [], failed: [] });

  // Lease expired, attempts (1) < max (2) → back to the queue as a resume.
  assert.deepEqual(await store.reapStale({ olderThanMs: 60_000, maxAttempts: 2, now: 120_000 }), { requeued: ['r1'], failed: [] });
  const requeued = await store.get('r1');
  assert.equal(requeued?.status, 'queued');
  assert.equal(requeued?.kind, 'resume', 'the retry continues from the checkpoint, it does not start over');
  assert.equal(requeued?.attempts, 1);

  // Claimed again (attempts → 2) and abandoned again: the budget is spent, so it FAILS.
  await store.claim('dead-worker-2', 130_000);
  assert.deepEqual(await store.reapStale({ olderThanMs: 60_000, maxAttempts: 2, now: 300_000 }), { requeued: [], failed: ['r1'] });
  const failed = await store.get('r1');
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error ?? '', /lease expired/);
  assert.equal(failed?.lockedBy, null, 'a failed job is never left holding a lock');
});

test('A4 queue: a heartbeat only renews the holder’s own lease', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'), 0);
  await store.claim('worker-a', 1_000);
  assert.equal(await store.heartbeat('r1', 'worker-a', 2_000), true);
  assert.equal((await store.get('r1'))?.lockedAt, 2_000);
  assert.equal(await store.heartbeat('r1', 'worker-b', 2_500), false, 'another pod cannot keep someone else’s lease alive');
  await store.complete('r1', 'done', { now: 3_000 });
  assert.equal(await store.heartbeat('r1', 'worker-a', 4_000), false, 'a settled job has no lease to renew');
});

test('A4 queue: a graceful stop puts the run back as a resume', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'), 0);
  await store.claim('worker-a', 1_000);
  await store.requeue('r1', 'worker-b', 1_500);
  assert.equal((await store.get('r1'))?.status, 'running', 'only the lease holder may hand the run back');
  await store.requeue('r1', 'worker-a', 2_000);
  const back = await store.get('r1');
  assert.equal(back?.status, 'queued');
  assert.equal(back?.kind, 'resume');
});

test('A4 events: the table holds exactly the SSE vocabulary', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  await assert.rejects(() => store.appendEvent('r1', 'node-finished' as never, {}), /not a run event/);
  const sink = runEventSink(store, 'r1');
  sink.write('node-started', { node: 'a' });
  sink.write('progress', { pct: 50 });
  sink.write('done', { ok: true });
  await sink.drained();
  assert.deepEqual((await store.eventsAfter('r1', 0)).map((e) => e.event), ['node-started', 'done']);
  assert.deepEqual(sink.problems(), ["dropped unknown run event 'progress'"]);
});

test('A4 events: the sink keeps seq in emit order even though writes are async', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  const sink = runEventSink(store, 'r1');
  for (let i = 0; i < 25; i += 1) sink.write('tool-step', { i });
  await sink.drained();
  const rows = await store.eventsAfter('r1', 0, 100);
  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.deepEqual(rows.map((r) => (r.data as { i: number }).i), Array.from({ length: 25 }, (_, i) => i));
});

test('A4 terminal: `error` and a non-parked `done` end a tail; a PARKED done does not', () => {
  const row = (event: RunEventRow['event'], data: unknown): RunEventRow => ({ runId: 'r', seq: 1, event, data, at: 0 });
  assert.equal(isTerminalEvent(row('error', { error: 'boom' })), true);
  assert.equal(isTerminalEvent(row('done', { ok: true })), true);
  assert.equal(isTerminalEvent(row('done', { parked: true })), false, 'the decision will continue this run on the same id');
  assert.equal(isTerminalEvent(row('node-started', {})), false);
});

test('A4 tail: from seq 0 the whole run replays, in order (what POST …/run streams)', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  await store.appendEvent('r1', 'node-started', { node: 'a' });
  await store.appendEvent('r1', 'node-completed', { node: 'a' });
  await store.appendEvent('r1', 'done', { ok: true });
  await store.complete('r1', 'done');

  const seen: string[] = [];
  const out = await tailRunEvents(store, 'r1', { until: 'settled', afterSeq: 0, pollMs: 1 }, (e) => seen.push(e.event));
  assert.deepEqual(seen, ['node-started', 'node-completed', 'done']);
  assert.equal(out.ended, 'terminal');
  assert.equal(out.lastSeq, 3);
});

test('A4 tail: a re-attach from a later seq gets ONLY what it missed (what GET …/run/stream does)', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  await store.appendEvent('r1', 'node-started', { node: 'a' });
  await store.appendEvent('r1', 'approval-required', { approvalId: 'ap1' });
  await store.appendEvent('r1', 'done', { parked: true });
  await store.complete('r1', 'parked');

  // The panel saw the first three frames and the run parked. The decision resumes it...
  const seen: string[] = [];
  const tail = tailRunEvents(store, 'r1', { until: 'terminal', afterSeq: 3, pollMs: 1 }, (e) => seen.push(e.event));
  await store.appendEvent('r1', 'resumed', { approvalId: 'ap1', decision: 'approved' });
  await store.appendEvent('r1', 'node-completed', { node: 'a' });
  await store.appendEvent('r1', 'done', { ok: true });
  await store.complete('r1', 'done');
  const out = await tail;
  assert.deepEqual(seen, ['resumed', 'node-completed', 'done'], 'no replay of what the client already rendered');
  assert.equal(out.ended, 'terminal');
});

test('A4 tail: a job that failed without a terminal frame still ends the tail', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  await store.complete('r1', 'failed', { error: 'the worker died' });
  const out = await tailRunEvents(store, 'r1', { until: 'terminal', afterSeq: 0, pollMs: 1, timeoutMs: 500 }, () => undefined);
  assert.equal(out.ended, 'settled', 'never a hung stream');
});

test('A4 tail: an unknown run is reported missing, not waited on', async () => {
  const store = memoryRunJobStore();
  const out = await tailRunEvents(store, 'ghost', { until: 'settled', pollMs: 1, timeoutMs: 200 }, () => undefined);
  assert.equal(out.ended, 'missing');
});

test('A4 tail: an aborted client stops the tail', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  const ctrl = new AbortController();
  const tail = tailRunEvents(store, 'r1', { until: 'terminal', pollMs: 1, signal: ctrl.signal }, () => undefined);
  ctrl.abort();
  assert.equal((await tail).ended, 'aborted');
});
