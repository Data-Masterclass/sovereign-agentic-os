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

test('a panel that mounts with NO local state (tab switch, reload, another browser) gets the completed run', async () => {
  // The process serving the page has no last run on its record at all — the run executed in
  // the worker. Before this, the panel came back empty and the run had to be started again.
  const store = await runJobStore();
  const t = 90_000;
  const body = {
    ok: true, path: ['clerk'], reachedEnd: true, finalText: 'Three invoices total 1,234.56 EUR.', warnings: ['a guard reads a channel nothing sets'],
    nodes: [{ node: 'clerk', status: 'ok', finalText: 'Three invoices total 1,234.56 EUR.', steps: [{ tool: 'list_files', summary: '3 files' }, { tool: 'get_file', args: '{"fileId":"as_1"}' }] }],
    contextUsage: { items: [{ kind: 'files', id: 'as_1', via: 'get_file', mode: 'read', confidence: 'captured' }], byKind: { data: [], knowledge: [], files: ['as_1'], metrics: [], connections: [] } },
    writeSummary: { line: 'wrote 1 to My Knowledge', wrote: [{ tab: 'knowledge', count: 1 }], wroteTotal: 1, heldTotal: 0 },
  };
  await store.enqueue({ runId: 'run_done', systemId: 'sys-mount', domain: 'finance', requestedBy: 'u1', principal: { id: 'u1', name: 'Owner', role: 'builder', domains: ['finance'], activeDomain: null }, input: { messages: [] }, kind: 'start' }, t);
  await store.claimById('run_done', 'w', t + 1);
  await store.appendEvent('run_done', 'done', body, t + 2);
  await store.complete('run_done', 'done', { lockedBy: 'w', now: t + 2 });

  for (const record of [undefined, null]) {
    const { lastRun, inFlight } = await latestRunView('sys-mount', 'u1', record);
    assert.equal(inFlight, null);
    assert.equal(lastRun?.runId, 'run_done');
    assert.equal(lastRun?.ok, true);
    assert.equal(lastRun?.output, 'Three invoices total 1,234.56 EUR.', 'result text');
    assert.deepEqual(lastRun?.nodes?.[0].steps.map((s) => s.tool), ['list_files', 'get_file'], 'per-agent steps');
    assert.equal(lastRun?.steps.length, 2);
    assert.deepEqual(lastRun?.warnings, ['a guard reads a channel nothing sets'], 'warnings');
    assert.deepEqual(lastRun?.contextUsage?.byKind.files, ['as_1'], 'context card');
    assert.equal(lastRun?.writeSummary?.wroteTotal, 1, 'outputs written');
    assert.equal(lastRun?.startedAt, t);
  }
  // The run is its runner's: a colleague who did not start it is not handed its contents.
  assert.equal((await latestRunView('sys-mount', 'u2', null)).lastRun, null);
});
