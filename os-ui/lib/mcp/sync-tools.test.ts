/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * MCP parity for the scheduled-sync engine: `set_dataset_sync` / `sync_dataset_now`
 * (write) + `get_sync_status` (read). Driven exactly as an AI client would — over
 * `handleRpc` / `tools/call` — with REAL governed stores (datasets, connections,
 * sync-runs, the strict `setDatasetSync` gate, the honest CronJob reconciler which
 * degrades to live:false off-cluster). ONLY the sync executor is mocked at its
 * module seam, so we can assert the tool's contract (edit gate BEFORE any run,
 * honest trigger, run-record passthrough) without a live Trino/K8s stack.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';

// Stub fetch BEFORE any store import so OpenSearch mirrors fail fast into the
// in-process offline mode (the connections-store tests' pattern).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

// ─── the ONE mocked seam: the governed sync executor ─────────────────────────
let SYNC_OUTCOME: unknown = { ok: false, status: 409, error: 'No sync is configured on this dataset' };
const SYNC_CALLS: { datasetId: string; trigger: string }[] = [];
mock.module('@/lib/data/sync-run-server', {
  namedExports: {
    runDatasetSync: async (datasetId: string, trigger: string) => {
      SYNC_CALLS.push({ datasetId, trigger });
      return SYNC_OUTCOME;
    },
    // Pure helper the DQ remediation server re-imports (batch-id lineage) — mirror
    // the real mint so the module mock stays load-compatible for the tool registry.
    sliceBatchId: (datasetId: string, highWatermark: string) =>
      `${datasetId}.${highWatermark.replace(/[^A-Za-z0-9_.:-]+/g, '-')}`.replace(/[^A-Za-z0-9_.:-]+/g, '-'),
  },
});

const { handleRpc } = await import('./server.ts');
type JsonRpcResponse = import('./server.ts').JsonRpcResponse;
type ToolError = import('./server.ts').ToolError;
const { __resetStore: resetData } = await import('@/lib/data/store');
const { __resetConnections } = await import('@/lib/connections/store');
const { __resetSyncRuns, recordSyncRun } = await import('@/lib/data/sync-runs');

// The OWNER (builder: may create the shared-credential Kajabi connection AND owns
// the dataset — the sync edit gate is owner/domain_admin/admin, re-checked in-lib).
const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
// An outsider in another domain — must never see, configure or trigger Ben's sync.
const zed: CurrentUser = { id: 'zed', name: 'Zed', domains: ['finance'], role: 'creator' };

async function call(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function payload<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
}

function errorOf(r: Record<string, unknown>): ToolError {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: ToolError }).error;
}

/** Fresh world: a Kajabi connection + a dataset, both owned by Ben. */
async function seed(): Promise<{ datasetId: string; connectionId: string }> {
  resetData();
  __resetConnections();
  __resetSyncRuns();
  SYNC_CALLS.length = 0;
  const conn = payload<{ id: string }>(await call(ben, 'create_connection', {
    name: 'Kajabi main', template: 'kajabi-api', credential: 'client_id:client_secret',
  }));
  const ds = payload<{ id: string }>(await call(ben, 'create_dataset', { name: 'Members' }));
  return { datasetId: ds.id, connectionId: conn.id };
}

type SyncSaved = {
  datasetId: string;
  platform: string | null;
  sync: {
    mode: string;
    cursor?: { kind: string; column: string };
    schedule: { cron: string };
    enabled: boolean;
    source: { schema: string; table: string };
  } | null;
  cron: { ok: boolean; live: boolean; detail: string };
};

// ─── set_dataset_sync ─────────────────────────────────────────────────────────
test('set_dataset_sync: Kajabi cursor is LOCKED to the documented field, presets map to the panel crons, cron outcome is honest', async () => {
  const { datasetId, connectionId } = await seed();

  // purchases → true incremental (updated_at). The caller passes NO cursor.
  const out = payload<SyncSaved>(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'purchases' }, mode: 'append', schedule: 'daily',
  }));
  assert.equal(out.platform, 'kajabi');
  assert.deepEqual(out.sync?.cursor, { kind: 'timestamp', column: 'updated_at' }, 'cursor locked to the documented field');
  assert.equal(out.sync?.schedule.cron, '0 6 * * *', 'the daily preset is the panel’s cron');
  assert.equal(out.sync?.enabled, true, 'enabled defaults to true');
  // Off-cluster the CronJob CANNOT be provisioned — the outcome must say so, never
  // claim a live trigger (the reconciler's honesty contract).
  assert.equal(out.cron.live, false, 'no fake live CronJob claim off-cluster');
  assert.match(out.cron.detail, /unreachable/i);

  // contacts → created_at-only (new-only incremental) — a DIFFERENT locked cursor.
  const contacts = payload<SyncSaved>(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'contacts' }, mode: 'append', schedule: 'hourly',
  }));
  assert.deepEqual(contacts.sync?.cursor, { kind: 'timestamp', column: 'created_at' });
  assert.equal(contacts.sync?.schedule.cron, '0 * * * *');
});

test('set_dataset_sync: MODE-LOCK — a cursorless Kajabi resource asked for incremental (or any merge) is a typed bad_request', async () => {
  const { datasetId, connectionId } = await seed();

  // `offers` documents no timestamp at all — incremental would be FAKE. Refused.
  const cursorless = errorOf(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'offers' }, mode: 'append', schedule: 'daily',
  }));
  assert.equal(cursorless.code, 'bad_request');
  assert.match(cursorless.reason, /full-refresh is the only honest sync mode/i);

  // merge needs a federated SQL source — never an API-batch platform.
  const merge = errorOf(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'purchases' }, mode: 'merge', mergeKeys: ['id'], schedule: 'daily',
  }));
  assert.equal(merge.code, 'bad_request');
  assert.match(merge.reason, /append or full-refresh only/i);

  // …but full-refresh on the cursorless resource is the honest mode and SAVES.
  const ok = payload<SyncSaved>(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'offers' }, mode: 'full-refresh', schedule: 'weekly',
  }));
  assert.equal(ok.sync?.mode, 'full-refresh');
  assert.equal(ok.sync?.cursor, undefined, 'full-refresh carries no cursor');
});

test('set_dataset_sync: governance — outsider denied with no existence leak; unknown connection is typed too', async () => {
  const { datasetId, connectionId } = await seed();

  // Zed (other domain) cannot even SEE Ben's Personal dataset → not_found, no leak.
  const denied = errorOf(await call(zed, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'purchases' }, mode: 'append', schedule: 'daily',
  }));
  assert.ok(denied.code === 'not_found' || denied.code === 'forbidden', `outsider refused (got ${denied.code})`);

  // A connection the caller cannot resolve is a typed error BEFORE anything saves.
  const badConn = errorOf(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId: 'conn_missing', source: { schema: 'x', table: 'y' }, mode: 'full-refresh', schedule: 'daily',
  }));
  assert.ok(badConn.code === 'not_found' || badConn.code === 'forbidden', `unknown connection refused (got ${badConn.code})`);
});

// ─── sync_dataset_now ─────────────────────────────────────────────────────────
test('sync_dataset_now: edit-gated BEFORE the executor, honest trigger (manual/reset), run record passed through verbatim', async () => {
  const { datasetId, connectionId } = await seed();
  payload(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'purchases' }, mode: 'append', schedule: 'daily',
  }));

  // Outsider: refused by the edit gate — the executor is NEVER invoked.
  const before = SYNC_CALLS.length;
  const denied = errorOf(await call(zed, 'sync_dataset_now', { datasetId }));
  assert.ok(denied.code === 'not_found' || denied.code === 'forbidden');
  assert.equal(SYNC_CALLS.length, before, 'a denied call never reaches the sync executor');

  // Owner: the honest ok run record comes back verbatim, trigger = manual.
  const run = {
    id: `${datasetId}:2026-06-27T10:00:00.000Z`, datasetId, startedAt: '2026-06-27T10:00:00.000Z',
    finishedAt: '2026-06-27T10:00:05.000Z', status: 'ok', mode: 'append', cursorBefore: null,
    cursorAfter: '2026-06-27T09:59:00Z', rowsAffected: 42, ranBy: 'ben', batchId: `${datasetId}.2026-06-27T09-59-00Z`,
  };
  SYNC_OUTCOME = { ok: true, run };
  const out = payload<{ skipped: boolean; run: typeof run }>(await call(ben, 'sync_dataset_now', { datasetId }));
  assert.equal(out.skipped, false);
  assert.deepEqual(out.run, run, 'the run record is the executor’s, untouched');
  assert.deepEqual(SYNC_CALLS.at(-1), { datasetId, trigger: 'manual' });

  // reset:true → the reset trigger (replace + restart cursor).
  payload(await call(ben, 'sync_dataset_now', { datasetId, reset: true }));
  assert.deepEqual(SYNC_CALLS.at(-1), { datasetId, trigger: 'reset' });

  // A held lease is an HONEST skip, not a phantom success.
  SYNC_OUTCOME = { ok: true, skipped: true, reason: 'Another sync run holds the lease', run: { ...run, status: 'skipped' } };
  const skipped = payload<{ skipped: boolean; reason: string }>(await call(ben, 'sync_dataset_now', { datasetId }));
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /holds the lease/);

  // Executor refusal (e.g. no sync configured) surfaces as the typed status.
  SYNC_OUTCOME = { ok: false, status: 409, error: 'No sync is configured on this dataset' };
  const conflict = errorOf(await call(ben, 'sync_dataset_now', { datasetId }));
  assert.equal(conflict.code, 'conflict');
});

// ─── get_sync_status ──────────────────────────────────────────────────────────
test('get_sync_status: config + platform + next run + newest-first history + watermark + derived quarantine, DLS-scoped', async () => {
  const { datasetId, connectionId } = await seed();
  payload(await call(ben, 'set_dataset_sync', {
    datasetId, connectionId, source: { schema: 'kajabi', table: 'purchases' }, mode: 'append', schedule: 'daily',
  }));

  // Seed the durable run history the way the executor writes it (ok, then error).
  recordSyncRun({
    datasetId, startedAt: '2026-06-26T06:00:00.000Z', finishedAt: '2026-06-26T06:00:04.000Z',
    status: 'ok', mode: 'append', cursorBefore: null, cursorAfter: '2026-06-26T05:59:00Z',
    rowsAffected: 10, ranBy: 'ben', batchId: `${datasetId}.hw1`,
  });
  recordSyncRun({
    datasetId, startedAt: '2026-06-27T06:00:00.000Z', finishedAt: '2026-06-27T06:00:02.000Z',
    status: 'error', mode: 'append', cursorBefore: '2026-06-26T05:59:00Z', error: 'Kajabi API 500', ranBy: 'ben',
  });

  type Status = {
    sync: { mode: string } | null; platform: string | null; nextRunAt: string | null;
    runs: { status: string; batchId?: string; cursorAfter?: string | null; error?: string }[];
    watermark: string | null; quarantined: boolean; consecutiveErrors: number; lastMaintenanceAt: string | null;
  };
  const s = payload<Status>(await call(ben, 'get_sync_status', { datasetId }));
  assert.equal(s.sync?.mode, 'append');
  assert.equal(s.platform, 'kajabi');
  assert.ok(s.nextRunAt, 'a daily preset yields an estimated next run');
  assert.equal(s.runs[0].status, 'error', 'history is newest first');
  assert.equal(s.runs[0].error, 'Kajabi API 500', 'the honest failure message rides along');
  assert.equal(s.runs[1].batchId, `${datasetId}.hw1`, 'batch ids are readable');
  assert.equal(s.watermark, '2026-06-26T05:59:00Z', 'watermark = cursorAfter of the latest OK run (the error kept it)');
  assert.equal(s.quarantined, false);
  assert.equal(s.consecutiveErrors, 1);

  // 9 more consecutive errors → the derived quarantine trips (threshold 10).
  for (let i = 0; i < 9; i++) {
    recordSyncRun({
      datasetId, startedAt: `2026-06-27T07:0${i}:00.000Z`, finishedAt: `2026-06-27T07:0${i}:01.000Z`,
      status: 'error', mode: 'append', error: 'Kajabi API 500', ranBy: 'ben',
    });
  }
  const q = payload<Status>(await call(ben, 'get_sync_status', { datasetId }));
  assert.equal(q.quarantined, true, '≥10 trailing errors ⇒ auto-paused');
  assert.equal(q.consecutiveErrors, 10);

  // DLS: an outsider gets a typed not_found — no existence leak, no history leak.
  const denied = errorOf(await call(zed, 'get_sync_status', { datasetId }));
  assert.ok(denied.code === 'not_found' || denied.code === 'forbidden');
});
