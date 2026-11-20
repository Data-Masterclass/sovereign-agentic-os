/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The run worker's OPA policy gate.
 * USER STORY: As a builder I want my run to wait while OPA has lost its policy state, and then to
 *             fail with a clear `policy_state_not_restored` error instead of "not granted".
 * ARCHITECTURE:
 *   - Pure loop test with the in-memory job store and a fake clock; the canary probe itself is
 *     exercised against the real OPA image in tests/opa/state-reconcile.int.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRunJobStore, type NewRunJob } from '@tabs/agents/lib/engine/jobs';
import { POLICY_STATE_NOT_RESTORED, workerTick, type WorkerLoopDeps, type WorkerLoopState } from '@tabs/agents/lib/engine/worker-loop';

const PRINCIPAL = { id: 'u1', name: 'Ada', role: 'builder' as const, domains: ['sales'], activeDomain: null };
const job = (runId: string): NewRunJob => ({ runId, systemId: 'sys-1', domain: 'sales', requestedBy: 'u1', principal: PRINCIPAL, input: { messages: [] }, kind: 'start' });

test('runs stay queued while policy state is missing, fail typed after the timeout, and run once it is back', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'), 0);
  await store.enqueue(job('r2'), 0);
  let clock = 0;
  let ready = false;
  const ran: string[] = [];
  const d: WorkerLoopDeps = {
    store, workerId: 'w1', leaseMs: 60_000, maxAttempts: 2, idleMs: 0, reapEveryMs: 1e12,
    sleep: async () => undefined, stopped: () => false, now: () => clock,
    execute: async (j) => { ran.push(j.runId); await store.complete(j.runId, 'done'); },
    policyReady: async () => ready,
    policyGateTimeoutMs: 60_000,
  };
  const state: WorkerLoopState = { lastReapAt: 0 };

  assert.equal(await workerTick(d, state), 'idle');
  clock = 59_000;
  assert.equal(await workerTick(d, state), 'idle');
  assert.equal((await store.get('r1'))?.status, 'queued', 'held, not run, within the timeout');
  assert.deepEqual(ran, []);

  clock = 61_000;
  assert.equal(await workerTick(d, state), 'ran');
  const failed = await store.get('r1');
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error ?? '', new RegExp(`^${POLICY_STATE_NOT_RESTORED}: `));
  const events = await store.eventsAfter('r1', 0);
  assert.ok(events.some((e) => e.event === 'error' && (e.data as { code?: string }).code === POLICY_STATE_NOT_RESTORED));
  assert.deepEqual(ran, [], 'the agent never ran');

  ready = true;
  assert.equal(await workerTick(d, state), 'ran');
  assert.deepEqual(ran, ['r2'], 'runs resume once the state is restored');
  assert.equal(state.policyNotReadySince, null);
});

test('a throwing gate counts as not restored (never as ready)', async () => {
  const store = memoryRunJobStore();
  await store.enqueue(job('r1'), 0);
  const d: WorkerLoopDeps = {
    store, workerId: 'w1', leaseMs: 60_000, maxAttempts: 2, idleMs: 0, reapEveryMs: 1e12,
    sleep: async () => undefined, stopped: () => false, now: () => 0,
    execute: async () => { throw new Error('must not run'); },
    policyReady: async () => { throw new Error('OPA down'); },
  };
  assert.equal(await workerTick(d, { lastReapAt: 0 }), 'idle');
  assert.equal((await store.get('r1'))?.status, 'queued');
});
