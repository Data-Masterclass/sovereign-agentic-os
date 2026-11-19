/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The system page asks THIS process's run store for the latest run
 * USER STORY: As a builder I open a system and see my latest run, even though the copy of the
 *             system this process holds still remembers an older one.
 * ARCHITECTURE: `latestRunView` over the process's real store selection (`runJobStore()`, the
 *             in-memory store here — no `AGENT_RUNS_DATABASE_URL` in a test), i.e. the exact call
 *             the system GET route makes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LastRun } from '@tabs/agents/lib/store';
import { runJobStore } from '@tabs/agents/lib/build/run-jobs-server';
import { latestRunView } from '@tabs/agents/lib/build/latest-run-server';

const RECORD: LastRun = { at: 1_000, running: false, ok: false, path: ['clerk'], traces: 0, held: 0, steps: Array.from({ length: 13 }, () => ({ node: 'clerk', tool: 'get_file', effect: 'allow' })), output: 'old', runId: 'run_old' };

test('with no run in the store the record is served, marked as the record', async () => {
  const out = await latestRunView('sys-wire-empty', 'u1', RECORD);
  assert.equal(out.lastRun?.runId, 'run_old');
  assert.equal(out.lastRun?.source, 'system-record');
});

test('a newer run in the store replaces the record this process remembers', async () => {
  const store = await runJobStore();
  const t = 50_000;
  await store.enqueue({ runId: 'run_new', systemId: 'sys-wire', domain: 'finance', requestedBy: 'u1', principal: { id: 'u1', name: 'Owner', role: 'builder', domains: ['finance'], activeDomain: null }, input: { messages: [] }, kind: 'start' }, t);
  assert.equal((await latestRunView('sys-wire', 'u1', RECORD)).lastRun, null, 'queued: nothing older is shown');
  assert.deepEqual((await latestRunView('sys-wire', 'u1', RECORD)).inFlight, { runId: 'run_new', startedAt: t });
  await store.claimById('run_new', 'w', t + 1);
  await store.appendEvent('run_new', 'done', { ok: true, path: ['clerk'], finalText: 'new', nodes: [{ node: 'clerk', status: 'ok', steps: [{ tool: 'list_files' }] }] }, t + 2);
  await store.complete('run_new', 'done', { lockedBy: 'w', now: t + 2 });
  const out = await latestRunView('sys-wire', 'u1', RECORD);
  assert.equal(out.lastRun?.runId, 'run_new');
  assert.equal(out.lastRun?.steps.length, 1);
  assert.equal(out.lastRun?.output, 'new');
  assert.equal(out.lastRun?.source, 'run-store');
});
