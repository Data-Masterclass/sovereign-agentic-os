/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 — the worker loop: claim, heartbeat, reap, and a SIGTERM that loses no run
 * USER STORY: As an operator I want the worker to drain the queue one run at a time, to renew the
 *             lease while a run is long, to stop claiming the moment SIGTERM arrives and hand the
 *             run it was on back to the queue (the checkpoint continues it), and to pick up a run
 *             whose pod vanished — once — before failing it visibly.
 * ARCHITECTURE:
 *   - `workerTick` / `workerLoop` with the store, the executor, the clock and `sleep` injected, so
 *     the whole failure matrix is deterministic and takes no wall-clock time.
 *   - The executor contract under test: the loop never leaves a job `running` — not when the
 *     executor settles it, and not when the executor throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRunJobStore, type NewRunJob, type RunJob } from '@tabs/agents/lib/engine/jobs';
import { workerLoop, workerTick, type WorkerLoopDeps } from '@tabs/agents/lib/engine/worker-loop';

const PRINCIPAL = { id: 'u1', name: 'Ada', role: 'builder' as const, domains: ['sales'], activeDomain: null };
const job = (runId: string, kind: 'start' | 'resume' = 'start'): NewRunJob => ({
  runId, systemId: 'sys-1', domain: 'sales', requestedBy: 'u1', principal: PRINCIPAL, input: { messages: [] }, kind,
});

function deps(store: ReturnType<typeof memoryRunJobStore>, over: Partial<WorkerLoopDeps> = {}): WorkerLoopDeps {
  return {
    store,
    workerId: 'worker-1',
    execute: async (j) => { await store.complete(j.runId, 'done'); },
    leaseMs: 60_000,
    maxAttempts: 2,
    idleMs: 0,
    reapEveryMs: 1_000,
    sleep: async () => undefined,
    stopped: () => false,
    now: () => 0,
    ...over,
  };
}

test('A4 worker: a tick claims one queued job and the executor settles it', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  await store.enqueue(job('r2'));
  const ran: string[] = [];
  const d = deps(store, { execute: async (j) => { ran.push(j.runId); await store.complete(j.runId, 'done'); } });

  assert.equal(await workerTick(d, { lastReapAt: 0 }), 'ran');
  assert.deepEqual(ran, ['r1'], 'oldest first, exactly one per tick');
  assert.equal((await store.get('r1'))?.status, 'done');
  assert.equal((await store.get('r2'))?.status, 'queued');
});

test('A4 worker: an idle tick does nothing and says so', async () => {
  const store = memoryRunJobStore();
  assert.equal(await workerTick(deps(store), { lastReapAt: 0 }), 'idle');
});

test('A4 worker: SIGTERM stops the loop before it claims anything new', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  const d = deps(store, { stopped: () => true });
  assert.equal(await workerTick(d, { lastReapAt: 0 }), 'stopped');
  assert.equal((await store.get('r1'))?.status, 'queued', 'the queued run waits for the next pod');
});

test('A4 worker: a SIGTERM between supersteps hands the run back as a resume — nothing is lost', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'), 0);
  let stopping = false;
  const d = deps(store, {
    stopped: () => stopping,
    // What `executeJob` does when the abort signal fired and the graph stopped before END:
    // drain the events, then put the row back. The checkpoint is what continues the thread.
    execute: async (j: RunJob) => {
      stopping = true;
      await store.appendEvent(j.runId, 'node-completed', { node: 'a' });
      await store.requeue(j.runId, j.lockedBy ?? 'worker-1');
    },
  });
  await workerLoop(d);
  const back = await store.get('r1');
  assert.equal(back?.status, 'queued');
  assert.equal(back?.kind, 'resume', 'the next worker continues the thread, it does not restart it');
  assert.equal(await store.lastSeq('r1'), 1, 'the events written before the stop are durable');
});

test('A4 worker: an executor that throws fails the job rather than leaving it `running`', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  const logs: string[] = [];
  const d = deps(store, { execute: async () => { throw new Error('boom'); }, log: (m) => logs.push(m) });
  assert.equal(await workerTick(d, { lastReapAt: 0 }), 'ran');
  const j = await store.get('r1');
  assert.equal(j?.status, 'failed');
  assert.match(j?.error ?? '', /boom/);
  assert.ok(logs.some((l) => /executor threw/.test(l)));
});

test('A4 worker: the lease reaper re-queues a dead pod’s run once, then fails it', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'), 0);
  await store.claim('dead-pod', 0);
  const logs: string[] = [];
  let clock = 0;
  const d = deps(store, {
    now: () => clock,
    leaseMs: 1_000,
    maxAttempts: 2,
    reapEveryMs: 1,
    log: (m) => logs.push(m),
    execute: async (j) => { await store.complete(j.runId, 'done'); },
  });

  // The lease is long past and the run is still `running` under a pod that is gone.
  clock = 10_000;
  assert.equal(await workerTick(d, { lastReapAt: 0 }), 'ran', 'the reap re-queued it and the same tick claimed it');
  assert.equal((await store.get('r1'))?.status, 'done');
  assert.ok(logs.some((l) => /re-queued run r1/.test(l)));

  // A second run that keeps dying: each abandoned claim burns one attempt, and the second reap
  // finds the budget spent — so the run FAILS instead of being retried forever.
  await store.enqueue(job('r2'), 10_000);
  await store.claim('dead-pod', 10_000);
  assert.deepEqual((await store.reapStale({ olderThanMs: 1_000, maxAttempts: 2, now: 50_000 })).requeued, ['r2']);
  await store.claim('another-dead-pod', 50_000);
  assert.equal((await store.get('r2'))?.attempts, 2, 'the budget is spent');
  const r2 = await store.reapStale({ olderThanMs: 1_000, maxAttempts: 2, now: 100_000 });
  assert.deepEqual(r2.failed, ['r2']);
  assert.equal((await store.get('r2'))?.status, 'failed');
});

test('A4 worker: a claim failure is logged and the loop keeps going', async () => {
  const store = memoryRunJobStore();
  const logs: string[] = [];
  const broken = { ...store, claim: async () => { throw new Error('connection reset'); } };
  const d = deps(store, { store: broken as unknown as typeof store, log: (m) => logs.push(m) });
  assert.equal(await workerTick(d, { lastReapAt: 0 }), 'idle');
  assert.ok(logs.some((l) => /claim failed: connection reset/.test(l)));
});

test('A4 worker: the loop drains the whole queue and then stops when told to', async () => {
  const store = memoryRunJobStore();
  for (const id of ['r1', 'r2', 'r3']) await store.enqueue(job(id));
  const ran: string[] = [];
  let stopping = false;
  const d = deps(store, {
    stopped: () => stopping,
    execute: async (j) => { ran.push(j.runId); await store.complete(j.runId, 'done'); },
    sleep: async () => { stopping = true; },
  });
  await workerLoop(d);
  assert.deepEqual(ran, ['r1', 'r2', 'r3']);
  assert.ok((await store.all()).every((j) => j.status === 'done'));
});

test('A4 worker: the heartbeat runs for the duration of a claim and is stopped afterwards', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'));
  const beats: string[] = [];
  let live = false;
  const d = deps(store, {
    heartbeat: (runId) => { live = true; beats.push(runId); return () => { live = false; }; },
    execute: async (j) => {
      assert.equal(live, true, 'the lease is being renewed WHILE the run executes');
      await store.complete(j.runId, 'done');
    },
  });
  await workerTick(d, { lastReapAt: 0 });
  assert.deepEqual(beats, ['r1']);
  assert.equal(live, false, 'and stopped the moment the run settles');
});
