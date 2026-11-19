/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        monitoring
 * FEATURE:    The runs lens and `list_runs` read agent runs from the durable run store
 * USER STORY: As a builder I want Monitoring to list the agent runs that happened — the one the
 *             worker finished a minute ago included, even though Langfuse has not ingested it —
 *             newest first, scoped to what I may see, with a failed run reading red, filterable by
 *             system and status; and when the run store does not answer I want to be told so, not
 *             shown an empty list.
 * ARCHITECTURE:
 *   - The run store is the real in-memory `RunJobStore` (the contract the Postgres store is
 *     pinned to), filled the way the worker fills it: `enqueue`, `claim`, `appendEvent('done')`,
 *     `complete`. Langfuse is a stubbed `fetch` that has ingested NOTHING.
 *   - The adapter is driven through its seam (`runSource`); the MCP tool end to end through
 *     `handleRpc`, with this process's run-store slot pointed at the seeded store (or at a store
 *     that cannot be reached).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, type JsonRpcResponse } from '@core/mcp/server';
import { collectRunList, collectRuns } from '@tabs/monitoring/lib/adapters/run-trace';
import { runListStatusOf, runListHealth, visibleToOf, type RunListItem } from '@tabs/monitoring/lib/adapters/run-store-runs';
import { deriveScope, filterScope } from '@tabs/monitoring/lib/scope-core';

// The agents tab's run store, loaded the way every door outside that tab reaches it (lazily).
const { memoryRunJobStore } = await import('@tabs/agents/lib/engine/jobs');
type MemoryRunJobStore = ReturnType<typeof memoryRunJobStore>;
type NewRunJob = Parameters<MemoryRunJobStore['enqueue']>[0];

const realFetch = globalThis.fetch;
beforeEach(() => {
  // Langfuse has ingested nothing (the worker's run is not there yet); every other read is empty.
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { __osRunJobsStore?: unknown }).__osRunJobsStore;
});

const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);
let seq = 0;
const uuid = () => `run_00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function job(over: Partial<NewRunJob> & { requestedBy: string; domain: string; systemId: string }): NewRunJob {
  return {
    runId: uuid(),
    kind: 'start',
    principal: { id: over.requestedBy, name: over.requestedBy, role: 'creator', domains: [over.domain], activeDomain: null },
    input: { messages: [{ role: 'user', content: 'go' }] },
    ...over,
  };
}

/** File + execute a run the way the worker does; `report` is its `done` frame (omit: still running). */
async function workerRun(store: MemoryRunJobStore, j: NewRunJob, at: number, report?: Record<string, unknown>, settle: 'done' | 'failed' | 'parked' = 'done'): Promise<string> {
  await store.enqueue(j, at);
  await store.claimById(j.runId, 'os-ui-worker-0', at);
  if (report) {
    await store.appendEvent(j.runId, 'done', { runId: j.runId, ...report }, at + 1000);
    await store.complete(j.runId, settle, { now: at + 1000, lockedBy: 'os-ui-worker-0' });
  }
  return j.runId;
}

const DONE = { ok: true, status: 'done', failed: false, parked: false, reachedEnd: true, finalText: 'secret output' };
const FAILED = { ok: false, status: 'failed', failed: true, failure: { node: 'writer', reason: 'the model refused' }, parked: false, reachedEnd: false };

const amir = deriveScope('creator', 'amir', ['sales']);
const ben = deriveScope('builder', 'ben', ['sales']);
const arya = deriveScope('admin', 'arya', ['sales']);

async function seeded() {
  const store = memoryRunJobStore();
  const ids = {
    amirDone: await workerRun(store, job({ requestedBy: 'amir', domain: 'sales', systemId: 'sys_a' }), T0, DONE),
    amirFailed: await workerRun(store, job({ requestedBy: 'amir', domain: 'sales', systemId: 'sys_a' }), T0 + 60_000, FAILED, 'done'),
    saraRunning: await workerRun(store, job({ requestedBy: 'sara', domain: 'sales', systemId: 'sys_b' }), T0 + 120_000),
    kenjiFinance: await workerRun(store, job({ requestedBy: 'kenji', domain: 'finance', systemId: 'sys_c' }), T0 + 180_000, DONE),
  };
  return { store, ids };
}

const source = (store: MemoryRunJobStore) => async () => store;
const noNames = async () => () => undefined;

test('a run the WORKER executed is listed although Langfuse has not ingested it', async () => {
  const { store, ids } = await seeded();
  const { items, runStore } = await collectRunList({ scope: amir, runSource: source(store), systemNames: noNames });
  assert.deepEqual(runStore, { available: true });
  const mine = items.find((it) => it.id === ids.amirDone) as RunListItem | undefined;
  assert.ok(mine, 'the worker-executed run is in the list');
  assert.equal(mine.status, 'done');
  assert.equal(mine.health, 'green');
  assert.equal(mine.owner, 'amir');
  assert.equal(mine.domain, 'sales');
  assert.equal(mine.links?.systemId, 'sys_a');
  assert.ok(!JSON.stringify(items).includes('secret output'), 'a listing never carries the run contents');
});

test('scope: a creator sees only their own runs, a builder their domain, an admin everything', async () => {
  const { store, ids } = await seeded();
  const list = async (scope: typeof amir) => filterScope(scope, (await collectRunList({ scope, runSource: source(store), systemNames: noNames })).items).map((i) => i.id).sort();
  assert.deepEqual(await list(amir), [ids.amirDone, ids.amirFailed].sort());
  assert.deepEqual(await list(ben), [ids.amirDone, ids.amirFailed, ids.saraRunning].sort());
  assert.deepEqual(await list(arya), Object.values(ids).sort());
  assert.deepEqual(visibleToOf(amir), { requestedBy: 'amir', domains: [] });
  assert.deepEqual(visibleToOf(ben), { requestedBy: 'ben', domains: ['sales'] });
  assert.equal(visibleToOf(arya), undefined);
});

test('scope is applied IN the read: a creator’s run is not crowded out by 60 newer runs of others', async () => {
  const store = memoryRunJobStore();
  const own = await workerRun(store, job({ requestedBy: 'amir', domain: 'sales', systemId: 'sys_a' }), T0, DONE);
  for (let i = 1; i <= 60; i += 1) await workerRun(store, job({ requestedBy: 'sara', domain: 'sales', systemId: 'sys_b' }), T0 + i * 1000, DONE);
  const { items } = await collectRunList({ scope: amir, runSource: source(store), systemNames: noNames, limit: 25 });
  assert.deepEqual(filterScope(amir, items).map((i) => i.id), [own]);
});

test('a failed run reads failed and red — even when its job row was settled `done`', async () => {
  const { store, ids } = await seeded();
  const { items } = await collectRunList({ scope: amir, runSource: source(store), systemNames: noNames });
  const failed = items.find((it) => it.id === ids.amirFailed) as RunListItem;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.health, 'red');
  assert.match(failed.detail, /writer/);
  assert.match(failed.detail, /the model refused/);
  // A row the reaper failed without any report is failed too.
  assert.equal(runListStatusOf({ status: 'failed', report: null }), 'failed');
  assert.equal(runListStatusOf({ status: 'parked', report: null }), 'parked');
  assert.equal(runListStatusOf({ status: 'done', report: { interrupted: true } }), 'interrupted');
  assert.equal(runListStatusOf({ status: 'done', report: { status: 'incomplete', reachedEnd: false } }), 'incomplete');
  assert.equal(runListStatusOf({ status: 'running', report: { failed: true } }), 'running', 'a re-queued resume is running again');
  assert.equal(runListHealth('parked'), 'amber');
  assert.equal(runListHealth('interrupted'), 'amber');
  assert.equal(runListHealth('running'), 'green');
});

test('filters: systemId and status narrow the list to matching agent runs', async () => {
  const { store, ids } = await seeded();
  const bySystem = await collectRunList({ scope: arya, filter: { systemId: 'sys_a' }, runSource: source(store), systemNames: noNames });
  assert.deepEqual(bySystem.items.map((i) => i.id).sort(), [ids.amirDone, ids.amirFailed].sort());
  const byStatus = await collectRunList({ scope: arya, filter: { status: 'failed' }, runSource: source(store), systemNames: noNames });
  assert.deepEqual(byStatus.items.map((i) => i.id), [ids.amirFailed]);
  const running = await collectRunList({ scope: arya, filter: { status: 'running' }, runSource: source(store), systemNames: noNames });
  assert.deepEqual(running.items.map((i) => i.id), [ids.saraRunning]);
  const both = await collectRunList({ scope: arya, filter: { systemId: 'sys_c', status: 'failed' }, runSource: source(store), systemNames: noNames });
  assert.deepEqual(both.items, []);
});

test('ordering: newest run first, titled with the system name when known', async () => {
  const { store, ids } = await seeded();
  const { items } = await collectRunList({ scope: arya, runSource: source(store), systemNames: async () => (id) => (id === 'sys_a' ? 'Lead scorer' : undefined) });
  assert.deepEqual(items.map((i) => i.id), [ids.kenjiFinance, ids.saraRunning, ids.amirFailed, ids.amirDone]);
  assert.equal(items.find((i) => i.id === ids.amirDone)?.title, 'Lead scorer — agent run');
  assert.equal(items.find((i) => i.id === ids.saraRunning)?.title, 'sys_b — agent run');
});

test('store unreachable → a typed degraded answer, never an empty or invented list', async () => {
  const down = async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); };
  const out = await collectRunList({ scope: amir, runSource: down, systemNames: noNames });
  assert.equal(out.runStore.available, false);
  assert.ok(!out.runStore.available && out.runStore.code === 'run_store_unavailable' && /ECONNREFUSED/.test(out.runStore.reason));
  assert.ok(!out.items.some((i) => i.source === 'mock'), 'no demo fixtures in place of the real answer');
  // The overview lens shows the viewer ONE `unknown` notice instead of looking empty.
  const lens = filterScope(amir, await collectRuns({ scope: amir, runSource: down, systemNames: noNames }));
  assert.equal(lens[0]?.id, 'run-store-unavailable');
  assert.equal(lens[0]?.health, 'unknown');
});

// ------------------------------------------------------------------ list_runs end to end --

function useStore(store: Promise<unknown>) {
  store.catch(() => {});
  (globalThis as { __osRunJobsStore?: unknown }).__osRunJobsStore = { url: '', store };
}

async function listRuns(user: CurrentUser, args: Record<string, unknown> = {}) {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_runs', arguments: args } });
  const r = (res as JsonRpcResponse).result as { isError?: boolean; content: { text: string }[]; structuredContent?: { error?: { code: string } } };
  return r;
}

test('list_runs reads the run store: the worker’s run, its status, the filters, and the store’s state', async () => {
  const { store, ids } = await seeded();
  useStore(Promise.resolve(store));
  const amirUser: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
  const r = await listRuns(amirUser, { systemId: 'sys_a', status: 'failed' });
  assert.notEqual(r.isError, true, r.content[0]?.text);
  const out = JSON.parse(r.content[0].text) as { runs: RunListItem[]; runStore: { available: boolean }; filters: unknown; count: number };
  assert.deepEqual(out.runStore, { available: true });
  assert.deepEqual(out.filters, { systemId: 'sys_a', status: 'failed' });
  assert.deepEqual(out.runs.map((x) => [x.id, x.status, x.health]), [[ids.amirFailed, 'failed', 'red']]);
  const all = JSON.parse((await listRuns(amirUser)).content[0].text) as { runs: RunListItem[] };
  assert.ok(all.runs.some((x) => x.id === ids.amirDone), 'unfiltered, the worker’s run is there too');
  assert.ok(!all.runs.some((x) => x.owner !== 'amir'), 'and nobody else’s');
});

test('list_runs: an unknown status is a typed 400; an unreachable store says so', async () => {
  const amirUser: CurrentUser = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };
  const bad = await listRuns(amirUser, { status: 'exploded' });
  assert.equal(bad.isError, true);
  useStore(Promise.reject(new Error('connect ECONNREFUSED')));
  const r = await listRuns(amirUser);
  assert.notEqual(r.isError, true);
  const out = JSON.parse(r.content[0].text) as { runStore: { available: boolean; code?: string } };
  assert.equal(out.runStore.available, false);
  assert.equal(out.runStore.code, 'run_store_unavailable');
});
