/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The run shown on page load is the latest run in the run store, with its own numbers
 * USER STORY: As a builder I ran a system twice. The second run made 3 tool calls and found no
 *             files; the screen must not show the first run's 13 calls and twelve files next to it.
 * ARCHITECTURE:
 *   - The reproduction at the level where it happened: two runs of one system, each finalised by
 *     the real `finalizeTeamRun` (the same function that writes the `done` frame and the stored
 *     last run). The os-ui process's system record still holds run 1 — the worker's `setLastRun`
 *     for run 2 never reached it — while the shared run store holds both.
 *   - `readLatestRun` + `pickLatestRun` over `memoryRunJobStore`, the contract store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRunJobStore, type NewRunJob } from '@tabs/agents/lib/engine/jobs';
import { finalizeTeamRun } from '@tabs/agents/lib/build/run-service';
import { pickLatestRun, readLatestRun } from '@tabs/agents/lib/build/latest-run';

const YAML = "version: '1'\nsystem:\n  name: Invoices\n  domain: finance\n  visibility: Personal\n";
const T = Date.UTC(2026, 10, 19, 8, 0, 0);
const MIN = 60_000;

type Step = { tool: string; args: Record<string, unknown>; result: string; isError: boolean };

/** A finished one-agent run, shaped as `runOsTeam` returns it. */
function teamRun(runId: string, steps: Step[], finalText: string) {
  return {
    runId,
    checkpointer: 'postgres',
    path: ['clerk'],
    reachedEnd: true,
    finalText,
    runs: [{ node: 'clerk', model: 'sovereign-default', status: 'ok', result: { finalText, steps } }],
  } as unknown as Parameters<typeof finalizeTeamRun>[0];
}

const OLD_FILE_IDS = Array.from({ length: 12 }, (_, i) => `file_old_${i + 1}`);

/** Run 1 (morning): one listing, twelve file reads, and a result about PDF text. */
const RUN_1 = teamRun(
  'run_11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  [
    { tool: 'list_files', args: { folder: '/Invoices' }, result: JSON.stringify({ files: OLD_FILE_IDS.map((id) => ({ id })) }), isError: false },
    ...OLD_FILE_IDS.map((id) => ({ tool: 'get_file', args: { fileId: id }, result: JSON.stringify({ id, name: `${id}.pdf`, text: '' }), isError: false })),
  ],
  'PDF text extraction failed – no readable content',
);

/** Run 2 (latest): two empty listings and a refused upload; it says there are no invoices. */
const RUN_2 = teamRun(
  'run_22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  [
    { tool: 'list_files', args: { folder: '/Invoices' }, result: JSON.stringify({ files: [] }), isError: false },
    { tool: 'list_files', args: {}, result: JSON.stringify({ files: [] }), isError: false },
    { tool: 'upload_file', args: { name: 'summary.md' }, result: JSON.stringify({ error: { code: 'forbidden', reason: 'not granted' } }), isError: true },
  ],
  'No invoices exist.',
);

function job(runId: string, over: Partial<NewRunJob> = {}): NewRunJob {
  return {
    runId,
    systemId: 'sys-inv',
    domain: 'finance',
    requestedBy: 'u1',
    principal: { id: 'u1', name: 'Owner', role: 'builder', domains: ['finance'], activeDomain: 'finance' },
    input: { messages: [] },
    kind: 'start',
    ...over,
  };
}

type Store = ReturnType<typeof memoryRunJobStore>;

/** File, execute and settle one run in the store, exactly as `executeJob` does: events, `done`, complete. */
async function settle(store: Store, j: NewRunJob, team: Parameters<typeof finalizeTeamRun>[0], startedAt: number) {
  const { body, lastRun } = finalizeTeamRun(team, false, YAML);
  await store.enqueue(j, startedAt);
  await store.claimById(j.runId, 'worker-1', startedAt + 1_000);
  await store.appendEvent(j.runId, 'node-started', { node: 'clerk' }, startedAt + 2_000);
  for (const n of body.nodes) for (const s of n.steps) await store.appendEvent(j.runId, 'tool-step', { node: n.node, tool: s.tool }, startedAt + 3_000);
  await store.appendEvent(j.runId, 'done', JSON.parse(JSON.stringify(body)), startedAt + MIN);
  await store.complete(j.runId, 'done', { lockedBy: 'worker-1', now: startedAt + MIN });
  return { body, lastRun: { ...lastRun, at: startedAt + MIN } };
}

async function twoRuns() {
  const store = memoryRunJobStore();
  const first = await settle(store, job(RUN_1.runId!), RUN_1, T);
  const second = await settle(store, job(RUN_2.runId!), RUN_2, T + 240 * MIN);
  // What the os-ui process still holds on the system record: run 1. Run 2 executed in the worker.
  return { store, staleRecord: first.lastRun, first, second };
}

test('REPRODUCTION: after a second run, everything shown comes from the second run only', async () => {
  const { store, staleRecord, second } = await twoRuns();

  // The source the panel was loaded from before the fix — the web process's record — is run 1:
  assert.equal(staleRecord.steps.length, 13);
  assert.equal(staleRecord.contextUsage?.byKind.files.length, 12);

  const shown = pickLatestRun(staleRecord, await readLatestRun(store, 'sys-inv', 'u1')).lastRun;
  assert.ok(shown, 'a run is shown');
  assert.equal(shown.runId, RUN_2.runId, 'the run id shown is the latest run');
  assert.equal(shown.source, 'run-store');
  assert.equal(shown.steps.length, 3, 'tool-call count is run 2’s own, not 13');
  assert.deepEqual(shown.steps.map((s) => s.tool), ['list_files', 'list_files', 'upload_file']);
  assert.equal(shown.nodes?.[0].steps.length, 3);
  assert.equal(shown.output, 'No invoices exist.', 'the final text is run 2’s');
  assert.equal(shown.ok, true);
  assert.equal(shown.failed, undefined);
  assert.deepEqual(shown.contextUsage, JSON.parse(JSON.stringify(second.body.contextUsage)), 'context usage is exactly run 2’s own record');
  assert.deepEqual(shown.contextUsage?.byKind.files, [], 'run 2 read no file');
  const shownIds = (shown.contextUsage?.items ?? []).map((i) => i.id);
  for (const id of OLD_FILE_IDS) assert.ok(!shownIds.includes(id), `${id} was read by run 1 only`);
  assert.equal(JSON.stringify(shown).includes('PDF text extraction failed'), false, 'nothing of run 1’s text anywhere in the shown run');
  assert.equal(shown.startedAt, T + 240 * MIN);
});

test('history stays truthful: run 1’s own record still lists the twelve files it read', async () => {
  const { store } = await twoRuns();
  const first = await store.get(RUN_1.runId!);
  const done = (await store.eventsAfter(RUN_1.runId!, 0)).filter((e) => e.event === 'done').at(-1);
  assert.ok(first && done);
  const usage = (done.data as { contextUsage: { byKind: { files: string[] } } }).contextUsage;
  assert.deepEqual([...usage.byKind.files].sort(), [...OLD_FILE_IDS].sort());
});

test('page load: the latest run is the caller’s own run of THIS system', async () => {
  const { store } = await twoRuns();
  // A later run of the same system by someone else, and a later run of another system by the caller.
  await settle(store, job('run_33333333-cccc-4ccc-8ccc-cccccccccccc', { requestedBy: 'u2', principal: { id: 'u2', name: 'Other', role: 'creator', domains: ['finance'], activeDomain: 'finance' } }), RUN_1, T + 300 * MIN);
  await settle(store, job('run_44444444-dddd-4ddd-8ddd-dddddddddddd', { systemId: 'sys-other' }), RUN_1, T + 310 * MIN);
  const mine = await readLatestRun(store, 'sys-inv', 'u1');
  assert.equal(mine?.lastRun?.runId, RUN_2.runId);
  assert.equal(mine?.lastRun?.steps.length, 3);
  assert.equal((await readLatestRun(store, 'sys-inv', 'u2'))?.lastRun?.steps.length, 13, 'the other user sees their own run');
  assert.equal(await readLatestRun(store, 'sys-inv', 'nobody'), null);
  assert.equal(await readLatestRun(store, 'sys-unknown', 'u1'), null);
});

test('a run in flight is not mixed with the previous one: no earlier result is offered', async () => {
  const { store, staleRecord } = await twoRuns();
  await store.enqueue(job('run_55555555-eeee-4eee-8eee-eeeeeeeeeeee'), T + 400 * MIN);
  const queued = pickLatestRun(staleRecord, await readLatestRun(store, 'sys-inv', 'u1'));
  assert.equal(queued.lastRun, null, 'neither run 2 nor the stale record is presented as this run’s result');
  assert.deepEqual(queued.inFlight, { runId: 'run_55555555-eeee-4eee-8eee-eeeeeeeeeeee', startedAt: T + 400 * MIN });
  await store.claimById('run_55555555-eeee-4eee-8eee-eeeeeeeeeeee', 'worker-1', T + 401 * MIN);
  await store.appendEvent('run_55555555-eeee-4eee-8eee-eeeeeeeeeeee', 'tool-step', { node: 'clerk', tool: 'list_files' }, T + 402 * MIN);
  const running = pickLatestRun(staleRecord, await readLatestRun(store, 'sys-inv', 'u1'));
  assert.equal(running.lastRun, null);
  assert.equal(running.inFlight?.runId, 'run_55555555-eeee-4eee-8eee-eeeeeeeeeeee');
});

test('a run that ended without a report is a FAILED run with its reason — not the run before it', async () => {
  const { store, staleRecord } = await twoRuns();
  const id = 'run_66666666-ffff-4fff-8fff-ffffffffffff';
  await store.enqueue(job(id), T + 500 * MIN);
  await store.claimById(id, 'worker-1', T + 500 * MIN);
  await store.appendEvent(id, 'error', { error: 'role-downgraded: the runner is no longer a builder' }, T + 501 * MIN);
  await store.complete(id, 'failed', { error: 'role-downgraded: the runner is no longer a builder', lockedBy: 'worker-1', now: T + 501 * MIN });
  const shown = pickLatestRun(staleRecord, await readLatestRun(store, 'sys-inv', 'u1')).lastRun;
  assert.equal(shown?.runId, id);
  assert.equal(shown?.failed, true);
  assert.equal(shown?.ok, false);
  assert.match(shown?.failureReason ?? '', /role-downgraded/);
  assert.deepEqual(shown?.steps, []);
  assert.equal(shown?.contextUsage, undefined);
  assert.equal(shown?.output, undefined);
});

test('a run whose agent failed keeps its own report: where it failed and why', async () => {
  const store = memoryRunJobStore();
  const failedTeam = { ...(RUN_2 as object), runId: 'run_77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reachedEnd: false, failed: true, failure: { node: 'clerk', reason: 'LiteLLM 503' } } as unknown as Parameters<typeof finalizeTeamRun>[0];
  await settle(store, job('run_77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), failedTeam, T);
  const shown = (await readLatestRun(store, 'sys-inv', 'u1'))?.lastRun;
  assert.equal(shown?.failed, true);
  assert.equal(shown?.failedNode, 'clerk');
  assert.equal(shown?.failureReason, 'LiteLLM 503');
  assert.equal(shown?.ok, false);
  assert.equal(shown?.steps.length, 3);
});

test('no run in the store (or the store unreachable): the system record is the fallback, and says so', () => {
  const record = finalizeTeamRun(RUN_1, false, YAML).lastRun;
  const out = pickLatestRun(record, null);
  assert.equal(out.lastRun?.runId, RUN_1.runId);
  assert.equal(out.lastRun?.source, 'system-record');
  assert.equal(out.inFlight, null);
  assert.deepEqual(pickLatestRun(null, null), { lastRun: null, inFlight: null });
});

test('the record wins only when it holds a DIFFERENT run that ended later (a run recovered after a restart)', async () => {
  const { store, staleRecord } = await twoRuns();
  const fromStore = await readLatestRun(store, 'sys-inv', 'u1');
  const recovered = { ...staleRecord, runId: 'run_88888888-bbbb-4bbb-8bbb-bbbbbbbbbbbb', at: T + 600 * MIN, interrupted: true };
  assert.equal(pickLatestRun(recovered, fromStore).lastRun?.runId, recovered.runId);
  assert.equal(pickLatestRun(recovered, fromStore).lastRun?.source, 'system-record');
  // The SAME run on the record (the inline case) — the store's report is the one shown.
  const sameRun = { ...staleRecord, runId: RUN_2.runId, at: T + 999 * MIN };
  assert.equal(pickLatestRun(sameRun, fromStore).lastRun?.source, 'run-store');
  assert.equal(pickLatestRun(sameRun, fromStore).lastRun?.steps.length, 3);
});

test('a resumed earlier run that finished last is the latest run', async () => {
  const { store } = await twoRuns();
  // Run 1 is resumed after run 2 and completes again: it is the run that was active most recently.
  await store.enqueue(job(RUN_1.runId!, { kind: 'resume' }), T + 700 * MIN);
  await store.claimById(RUN_1.runId!, 'worker-1', T + 700 * MIN);
  await store.appendEvent(RUN_1.runId!, 'done', JSON.parse(JSON.stringify(finalizeTeamRun(RUN_1, false, YAML).body)), T + 701 * MIN);
  await store.complete(RUN_1.runId!, 'done', { lockedBy: 'worker-1', now: T + 701 * MIN });
  const shown = (await readLatestRun(store, 'sys-inv', 'u1'))?.lastRun;
  assert.equal(shown?.runId, RUN_1.runId);
  assert.equal(shown?.startedAt, T, 'its start time is when it was first filed');
  assert.equal(shown?.at, T + 701 * MIN);
});

// ------------------------------------------------- declared outputs on reload --

const SAVED = { key: 'files:personal:/reports:report', index: 0, kind: 'files', name: 'Report', target: { scope: 'personal', path: '/reports' }, state: 'saved', id: 'as_1', link: '/files?focus=as_1', message: 'Saved to My files /reports/x.md' };
const FAILED = { key: 'knowledge:personal:/results:result', index: 1, kind: 'knowledge', name: 'Result', target: { scope: 'personal', path: '/results' }, state: 'failed', retry: 'again', reason: 'knowledge store unreachable', message: 'Not saved: knowledge store unreachable' };

test('a reload shows the run’s declared outputs from its own done frame — and a later "Try saving again" over it', async () => {
  const store = memoryRunJobStore();
  const runId = RUN_2.runId!;
  const { body } = finalizeTeamRun(RUN_2, false, YAML);
  await store.enqueue(job(runId), T);
  await store.claimById(runId, 'worker-1', T + 1_000);
  const warning = 'Completed with unsaved outputs — “Result”: knowledge store unreachable';
  await store.appendEvent(runId, 'outputs-saving', { outputs: [{ ...SAVED, state: 'pending' }, { ...FAILED, state: 'pending' }] }, T + 2_000);
  await store.appendEvent(runId, 'done', JSON.parse(JSON.stringify({ ...body, outputs: [SAVED, FAILED], warnings: [warning] })), T + MIN);
  await store.complete(runId, 'done', { lockedBy: 'worker-1', now: T + MIN });

  const first = (await readLatestRun(store, 'sys-inv', 'u1'))!.lastRun!;
  assert.deepEqual(first.outputs!.map((o) => o.state), ['saved', 'failed'], 'the done frame’s list, not the pending one before it');
  assert.deepEqual(first.warnings, [warning]);

  // The person pressed "Try saving again" and it worked: the route appended `outputs-saved`.
  const fixed = { ...FAILED, state: 'saved', id: 'pk_1', retry: undefined, reason: undefined, message: 'Saved to My knowledge /results as “Result”' };
  await store.appendEvent(runId, 'outputs-saved', { outputs: [SAVED, fixed], warnings: [], completedWithUnsavedOutputs: false }, T + 5 * MIN);
  const after = (await readLatestRun(store, 'sys-inv', 'u1'))!.lastRun!;
  assert.deepEqual(after.outputs!.map((o) => o.state), ['saved', 'saved']);
  assert.equal(after.warnings, undefined, 'the "completed with unsaved outputs" line is gone once the save worked');
  assert.equal(after.output, 'No invoices exist.', 'the rest of the report is the run’s own');
});
