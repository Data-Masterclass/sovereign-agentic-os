/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The worker pool — several runs at once in one worker process
 * USER STORY: As a course trainer I want twelve participants' runs to execute side by side instead of
 *             queueing behind each other for half an hour (course incident 2026-11-27), without two
 *             slots ever taking the same run or a slot mistaking a sibling's claim for its own lease.
 * ARCHITECTURE: exercises `workerPool` / `slotDeps` (engine/worker-loop.ts) against the in-memory
 *             run store; the executor blocks on a gate so concurrency is observed, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRunJobStore, type NewRunJob } from '@tabs/agents/lib/engine/jobs';
import { slotDeps, workerPool, workerLoop, type WorkerLoopDeps } from '@tabs/agents/lib/engine/worker-loop';

const PRINCIPAL = { id: 'u1', name: 'Ada', role: 'builder' as const, domains: ['sales'], activeDomain: null };
const job = (runId: string): NewRunJob => ({
  runId, systemId: 'sys-1', domain: 'sales', requestedBy: 'u1', principal: PRINCIPAL, input: { messages: [] }, kind: 'start',
});

function base(store: ReturnType<typeof memoryRunJobStore>, over: Partial<WorkerLoopDeps> = {}): WorkerLoopDeps {
  return {
    store,
    workerId: 'pod/1',
    execute: async (j) => { await store.complete(j.runId, 'done'); },
    leaseMs: 60_000,
    maxAttempts: 2,
    idleMs: 0,
    reapEveryMs: 1_000,
    sleep: async () => { await new Promise((r) => setImmediate(r)); },
    stopped: () => false,
    ...over,
  };
}

test('worker pool: N slots execute N runs at the same time, each run exactly once', async () => {
  const store = memoryRunJobStore();
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) await store.enqueue(job(id));
  let inFlight = 0;
  let peak = 0;
  const ran: string[] = [];
  const holders = new Map<string, string | undefined>();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let stopping = false;
  const depsFor = () => base(store, {
    stopped: () => stopping,
    execute: async (j) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      ran.push(j.runId);
      holders.set(j.runId, j.lockedBy);
      if (peak === 3) release();
      await gate;
      inFlight--;
      await store.complete(j.runId, 'done');
      if ((await store.all()).every((x) => x.status === 'done')) stopping = true;
    },
  });
  await workerPool(depsFor, 3);
  assert.equal(peak, 3, 'three slots ran three runs concurrently');
  assert.deepEqual([...ran].sort(), ['r1', 'r2', 'r3', 'r4', 'r5'], 'every run once, none twice');
  assert.ok((await store.all()).every((j) => j.status === 'done'));
  const ids = new Set([...holders.values()]);
  assert.ok([...ids].every((h) => /^pod\/1#[0-2]$/.test(String(h))), `each claim carries its slot identity: ${[...ids].join(', ')}`);
});

test('worker pool: only slot 0 reaps and sweeps retention; the others have their own identity and no chores', () => {
  const store = memoryRunJobStore();
  const sweep = async () => undefined;
  const b = base(store, { sweepRetention: sweep, retentionEveryMs: 1_000 });
  const s0 = slotDeps(b, 0, 3);
  const s2 = slotDeps(b, 2, 3);
  assert.equal(s0.workerId, 'pod/1#0');
  assert.equal(s0.sweepRetention, sweep);
  assert.equal(s0.reapEveryMs, 1_000);
  assert.equal(s2.workerId, 'pod/1#2');
  assert.equal(s2.sweepRetention, undefined);
  assert.equal(s2.reapEveryMs, Number.POSITIVE_INFINITY);
  assert.equal(slotDeps(b, 0, 1), b, 'concurrency 1 is exactly the old single loop (same identity)');
});

test('worker pool: a chore-less slot never runs the lease reaper, not even on its first tick', async () => {
  const store = memoryRunJobStore();
  let reaps = 0;
  const counting = { ...store, reapStale: async (o: Parameters<typeof store.reapStale>[0]) => { reaps++; return store.reapStale(o); } };
  let ticks = 0;
  const d = slotDeps(base(counting, { stopped: () => ticks++ > 3 }), 1, 2);
  await workerLoop(d);
  assert.equal(reaps, 0);
});

test('worker pool: a stop request ends every slot between runs', async () => {
  const store = memoryRunJobStore();
  let stopping = false;
  let sleeps = 0;
  const depsFor = () => base(store, { stopped: () => stopping, sleep: async () => { if (++sleeps >= 4) stopping = true; await new Promise((r) => setImmediate(r)); } });
  await workerPool(depsFor, 4);
  assert.ok(stopping);
});

test('worker pool: a run still executing in THIS process (RunInFlightError after a reap) is re-queued, never failed', async () => {
  const { settlementOf } = await import('@tabs/agents/lib/engine/worker-loop');
  assert.deepEqual(settlementOf({ leaseLost: false, stopping: false, failure: 'run is already in flight', inFlightHere: true }), { kind: 'requeue' });
  assert.equal(settlementOf({ leaseLost: true, stopping: false, failure: 'x', inFlightHere: true }).kind, 'abandon', 'a lost lease still wins');
  assert.deepEqual(settlementOf({ leaseLost: false, stopping: false, failure: 'boom' }), { kind: 'complete', status: 'failed', error: 'boom' });
});
