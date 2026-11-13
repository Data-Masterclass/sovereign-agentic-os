/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The retention sweep — what it deletes, what it must never delete, what it defers
 * USER STORY: As an operator I want proof that a run parked on an approval survives forever, that
 *             a run that finished inside the window is untouched, and that a sweep which fails
 *             part way through leaves the run RETRYABLE instead of half-deleted.
 * ARCHITECTURE: the in-memory `RunJobStore` plus a 3-line fake checkpointer; no database, no timer,
 *               no clock — `now` is injected, so "31 days ago" is arithmetic, not a wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRunJobStore, type MemoryRunJobStore, type NewRunJob, type RunJobStatus } from '@tabs/agents/lib/engine/jobs';
import { sweepRetention, type ThreadDeleter } from '@tabs/agents/lib/engine/retention';
import { parseRetentionDays, retentionCutoff, DEFAULT_RETENTION_DAYS } from '@core/kernel/agent-run-retention';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T12:00:00.000Z');

function job(runId: string): NewRunJob {
  return {
    runId,
    systemId: 'sys_1',
    domain: 'sales',
    requestedBy: 'bea',
    principal: { id: 'bea', domains: ['sales'], role: 'creator' },
    input: {},
    kind: 'start',
  } as NewRunJob;
}

/** Seed one run that settled `ageDays` ago with `events` events. */
async function seed(store: MemoryRunJobStore, runId: string, status: RunJobStatus, ageDays: number, events = 2): Promise<void> {
  const at = NOW - ageDays * DAY;
  await store.enqueue(job(runId), at);
  await store.claim('w1', at);
  for (let i = 0; i < events; i += 1) await store.appendEvent(runId, 'node-started', { i }, at);
  if (status !== 'running' && status !== 'queued') {
    await store.complete(runId, status as 'done' | 'parked' | 'failed', { now: at, lockedBy: 'w1' });
  }
}

/** A checkpointer that only records which threads it was asked to drop. */
function fakeSaver(fail?: (threadId: string) => boolean): ThreadDeleter & { dropped: string[] } {
  const dropped: string[] = [];
  return {
    dropped,
    async deleteThread(threadId: string) {
      if (fail?.(threadId)) throw new Error(`checkpoint store refused ${threadId}`);
      dropped.push(threadId);
    },
  };
}

test('retention window: the default is 30 days, 0 means keep forever, and garbage never means 0', () => {
  assert.equal(parseRetentionDays(undefined), DEFAULT_RETENTION_DAYS);
  assert.equal(parseRetentionDays(''), DEFAULT_RETENTION_DAYS);
  assert.equal(parseRetentionDays('   '), DEFAULT_RETENTION_DAYS);
  // A typo must fall back to the DEFAULT, not to "retain nothing" and not to "retain forever".
  assert.equal(parseRetentionDays('thirty'), DEFAULT_RETENTION_DAYS);
  assert.equal(parseRetentionDays('7'), 7);
  assert.equal(parseRetentionDays('0'), 0, 'an explicit 0 is the documented "keep everything"');
  assert.equal(parseRetentionDays('-5'), 0);
  assert.equal(parseRetentionDays('0.5'), 1, 'a fraction floors at one whole day, never at zero');
  assert.equal(retentionCutoff(NOW, 0), null, 'no window ⇒ nothing is eligible');
  assert.equal(retentionCutoff(NOW, 30), NOW - 30 * DAY);
});

test('retention: a run that settled outside the window loses its checkpoint, its events and its job row', async () => {
  const store = memoryRunJobStore();
  await seed(store, 'run_old', 'done', 31, 3);
  const saver = fakeSaver();

  const out = await sweepRetention({ store, checkpointer: saver, days: 30, now: () => NOW });
  assert.equal(out.ran, true);
  assert.deepEqual(out, { ran: true, deleted: 1, jobRows: 1, eventRows: 3, checkpoints: 1, failed: 0, more: false });
  assert.deepEqual(saver.dropped, ['run_old'], 'the checkpoint thread id IS the run id');
  assert.equal(await store.get('run_old'), null);
  assert.deepEqual(store.events('run_old'), []);
});

test('retention: a PARKED run is never swept, however old — its checkpoint IS the pending approval', async () => {
  const store = memoryRunJobStore();
  await seed(store, 'run_parked', 'parked', 400);
  const saver = fakeSaver();

  const out = await sweepRetention({ store, checkpointer: saver, days: 30, now: () => NOW });
  assert.equal(out.deleted, 0, 'a run waiting on a human decision has no age limit');
  assert.deepEqual(saver.dropped, []);
  assert.ok(await store.get('run_parked'), 'the job row survives');
  assert.equal(store.events('run_parked').length, 2, 'and so does its event log');
});

test('retention: a run inside the window is untouched, and `failed` is swept like `done`', async () => {
  const store = memoryRunJobStore();
  await seed(store, 'run_recent', 'done', 29);
  await seed(store, 'run_failed_old', 'failed', 31);
  const saver = fakeSaver();

  const out = await sweepRetention({ store, checkpointer: saver, days: 30, now: () => NOW });
  assert.deepEqual(saver.dropped, ['run_failed_old']);
  assert.equal(out.deleted, 1);
  assert.ok(await store.get('run_recent'), '29 days old with a 30-day window is inside it');
});

test('retention: days = 0 disables the sweep entirely — nothing is listed, nothing is deleted', async () => {
  const store = memoryRunJobStore();
  await seed(store, 'run_ancient', 'done', 9999);
  const saver = fakeSaver();
  let listed = 0;
  const spy = { ...store, settledBefore: async (c: number, l: number) => { listed += 1; return store.settledBefore(c, l); } };

  const out = await sweepRetention({ store: spy, checkpointer: saver, days: 0, now: () => NOW });
  assert.equal(out.ran, false, 'retention off is reported as "did not run", not as "found nothing"');
  assert.equal(listed, 0, 'it must not even query the store');
  assert.ok(await store.get('run_ancient'));
});

test('retention: a checkpoint that cannot be dropped DEFERS the run — never a half-deleted row', async () => {
  const store = memoryRunJobStore();
  await seed(store, 'run_a', 'done', 31);
  await seed(store, 'run_stuck', 'done', 31);
  const saver = fakeSaver((id) => id === 'run_stuck');

  const out = await sweepRetention({ store, checkpointer: saver, days: 30, now: () => NOW });
  assert.equal(out.deleted, 1, 'the healthy run is still swept — one bad run does not stop the sweep');
  assert.equal(out.failed, 1);
  assert.equal(await store.get('run_a'), null);
  // The point: the job row is STILL THERE, so the next sweep finds it again. Deleting the row
  // first would have orphaned the checkpoint with nothing left to name it.
  assert.ok(await store.get('run_stuck'), 'the deferred run stays eligible for the next sweep');
  assert.equal(store.events('run_stuck').length, 2, 'and keeps its events, so the run is still readable');
});

test('retention: a run RESUMED between the listing and the delete is spared (the re-read is the guard)', async () => {
  const store = memoryRunJobStore();
  await seed(store, 'run_raced', 'done', 31);
  const saver = fakeSaver();
  // The listing is a snapshot. Simulate the race: the row is re-queued after it was listed.
  const spy = {
    ...store,
    settledBefore: async () => ['run_raced'],
    get: async (id: string) => {
      const j = await store.get(id);
      return j ? { ...j, status: 'running' as RunJobStatus } : null;
    },
  };

  const out = await sweepRetention({ store: spy, checkpointer: saver, days: 30, now: () => NOW });
  assert.equal(out.deleted, 0);
  assert.deepEqual(saver.dropped, [], 'deleting a live run’s checkpoint would destroy the run');
});

test('retention: the batch is bounded and a full batch says more remain', async () => {
  const store = memoryRunJobStore();
  for (let i = 0; i < 5; i += 1) await seed(store, `run_${i}`, 'done', 31, 1);
  const saver = fakeSaver();

  const first = await sweepRetention({ store, checkpointer: saver, days: 30, batch: 2, now: () => NOW });
  assert.equal(first.deleted, 2);
  assert.equal(first.more, true, 'a full batch tells the operator the backlog is still draining');
  const second = await sweepRetention({ store, checkpointer: saver, days: 30, batch: 2, now: () => NOW });
  assert.equal(second.deleted, 2);
  const third = await sweepRetention({ store, checkpointer: saver, days: 30, batch: 2, now: () => NOW });
  assert.equal(third.deleted, 1);
  assert.equal(third.more, false);
  assert.deepEqual(store.all(), [], 'the backlog drains over successive sweeps');
});

test('retention: with no checkpointer the tables are still swept (and nothing is claimed to be)', async () => {
  const store = memoryRunJobStore();
  await seed(store, 'run_old', 'done', 31);
  const out = await sweepRetention({ store, checkpointer: null, days: 30, now: () => NOW });
  assert.equal(out.deleted, 1);
  assert.equal(out.checkpoints, 0, 'it must not report a checkpoint it never deleted');
  assert.equal(await store.get('run_old'), null);
});

test('retention: a store that cannot be listed is reported, not thrown — the worker loop must not die', async () => {
  const store = memoryRunJobStore();
  const logs: string[] = [];
  const spy = { ...store, settledBefore: async () => { throw new Error('connection terminated'); } };
  const out = await sweepRetention({ store: spy, checkpointer: null, days: 30, now: () => NOW, log: (m) => logs.push(m) });
  assert.deepEqual(out, { ran: true, deleted: 0, jobRows: 0, eventRows: 0, checkpoints: 0, failed: 0, more: false });
  assert.match(logs.join('\n'), /could not list expired runs.*connection terminated/);
});
