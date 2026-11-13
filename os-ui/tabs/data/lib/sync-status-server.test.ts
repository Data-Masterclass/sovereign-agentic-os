/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Sync read-back shapes — Dagster with the flag on, the OS ledger with it off
 * USER STORY: As a maintainer I want proof that the panel's run rows, the quarantine flag and the
 *             next tick come from Dagster when `DATA_PROJECT_GIT` is on, that a Dagster outage is
 *             REPORTED (empty runs + an error) rather than faked, and that the flag-off payload is
 *             byte-for-byte the ledger-derived one the surfaces shipped before B2.
 * ARCHITECTURE: every Dagster operation is injected (`deps.dagster`), so the test asserts the
 *               MAPPING, never a network call; the flag is pinned per test.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';
import {
  syncStatusFor, latestSyncSignals, runToView, runStatusToSync, consecutiveFailures,
} from '@tabs/data/lib/sync-status-server';
import { parseDataset, type Dataset } from '@tabs/data/lib/dataset-schema';
import { recordSyncRun, __resetSyncRuns } from '@tabs/data/lib/sync-runs';
import type { DagsterRun, ScheduleTick } from '@core/infra/dagster';

afterEach(() => {
  __setDataProjectGitForTests(null);
  __resetSyncRuns();
});

function dataset(sync: boolean): Dataset {
  return parseDataset(
    JSON.stringify({
      id: 'ds_1', name: 'Events', domain: 'sales', owner: 'bea', tier: 'dataset', origin: 'ingested',
      description: '', columns: [], versions: { bronze: { built: true }, silver: { built: false }, gold: { built: false } },
      ...(sync
        ? { sync: { connectionId: 'conn_1', source: { schema: 'public', table: 'events' }, mode: 'append', cursor: { kind: 'timestamp', column: 'updated_at' }, schedule: { cron: '*/15 * * * *' }, enabled: true } }
        : {}),
    }),
  );
}

function run(over: Partial<DagsterRun> = {}): DagsterRun {
  return {
    runId: 'r1', status: 'SUCCESS', jobName: 'sales__ds_1',
    startedAt: '2026-11-13T06:00:00.000Z', endedAt: '2026-11-13T06:01:00.000Z',
    tags: { 'os/dataset': 'ds_1', 'os/principal': 'bea', 'os/commit': 'c'.repeat(40), 'os/batch_id': 'b_1' },
    assetSelection: ['sales/silver_events'], ...over,
  };
}

const tick: ScheduleTick = { name: 'sales__ds_1', cron: '*/15 * * * *', timezone: 'UTC', status: 'RUNNING', nextTickAt: '2026-11-13T06:15:00.000Z' };

function dg(runs: DagsterRun[], t: ScheduleTick | null = tick, err?: string) {
  return {
    runsForDataset: async () => (err ? { ok: false as const, error: err } : { ok: true as const, data: runs }),
    nextTick: async () => (t ? { ok: true as const, data: t } : { ok: false as const, error: 'ScheduleNotFoundError: none' }),
    recentOsRuns: async () => (err ? { ok: false as const, error: err } : { ok: true as const, data: runs }),
  };
}

test('flag ON: runs, next tick, commit and batch id come from Dagster; the source says so', async () => {
  __setDataProjectGitForTests(true);
  const s = await syncStatusFor(dataset(true), { dagster: dg([run(), run({ runId: 'r0', status: 'FAILURE', endedAt: null })]), location: 'sovereign' });
  assert.equal(s.source, 'dagster');
  assert.equal(s.runs.length, 2);
  assert.deepEqual(s.runs[0], {
    id: 'r1', dagsterRunId: 'r1', startedAt: '2026-11-13T06:00:00.000Z', finishedAt: '2026-11-13T06:01:00.000Z',
    status: 'ok', mode: 'append', batchId: 'b_1', commit: 'c'.repeat(40), ranBy: 'bea',
  });
  assert.equal(s.runs[1].status, 'error');
  assert.match(s.runs[1].error!, /Dagster run failure/);
  assert.equal(s.nextRunAt, '2026-11-13T06:15:00.000Z');
  assert.equal(s.quarantined, false);
  assert.equal(s.consecutiveErrors, 0, 'the newest run succeeded');
  assert.equal(s.watermark, null, 'the watermark is max(cursor) in the model (B3), not an OS ledger value');
  assert.deepEqual(s.dagster, { schedule: 'sales__ds_1', location: 'sovereign', status: 'RUNNING', error: null });
});

test('flag ON: a STOPPED schedule the OS believes enabled is quarantined; an outage is reported, not faked', async () => {
  __setDataProjectGitForTests(true);
  const paused = await syncStatusFor(dataset(true), { dagster: dg([run({ status: 'FAILURE' })], { ...tick, status: 'STOPPED', nextTickAt: null }) });
  assert.equal(paused.quarantined, true);
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.consecutiveErrors, 1);

  const down = await syncStatusFor(dataset(true), { dagster: dg([], tick, 'HTTP 503') });
  assert.deepEqual(down.runs, []);
  assert.equal(down.dagster!.error, 'HTTP 503');
  assert.equal(down.quarantined, false, 'an outage is never a quarantine claim');
});

test('flag OFF: the ledger-derived payload, and no Dagster call at all', async () => {
  __setDataProjectGitForTests(false);
  let called = false;
  const spy = { runsForDataset: async () => { called = true; return { ok: true as const, data: [] }; }, nextTick: async () => { called = true; return { ok: false as const, error: 'x' }; }, recentOsRuns: async () => { called = true; return { ok: true as const, data: [] }; } };
  const s = await syncStatusFor(dataset(true), { dagster: spy });
  assert.equal(called, false);
  assert.equal(s.source, 'ledger');
  assert.deepEqual(s.runs, []);
  assert.equal(s.quarantined, false);
  // Review H-3b: this used to be `nextCronRun(...)` — a confident timestamp for a slice NOTHING
  // fires, because B4 deleted both the CronJob provisioning and the sweeps. `null` is the truth,
  // and `source: 'ledger'` is how a surface knows why.
  assert.equal(s.nextRunAt, null, 'with the flag off nothing schedules the saved cron, so there is no next run');
  assert.equal(s.dagster, undefined);
});

test('latestSyncSignals: ONE tag-filtered read PER dataset — a quiet dataset is not under-reported', async () => {
  __setDataProjectGitForTests(true);
  // Review B2-review-M4: the old implementation took the newest 200 runs of the WHOLE instance
  // with an empty filter and grouped by tag, so a dataset whose last sync fell outside that window
  // read as "never synced". Here `ds_2`'s run is the 201st newest overall and must still be found.
  const asked: string[] = [];
  const out = await latestSyncSignals(['ds_1', 'ds_2', 'ds_3'], {
    dagster: {
      nextTick: async () => ({ ok: false as const, error: 'unused' }),
      runsForDataset: async (id: string) => {
        asked.push(id);
        if (id === 'ds_1') return { ok: true as const, data: [run({ runId: 'new' })] };
        if (id === 'ds_2') return { ok: true as const, data: [run({ runId: 'ancient', endedAt: '2026-11-01T00:00:00.000Z' })] };
        return { ok: true as const, data: [] };
      },
    },
  });
  assert.deepEqual(asked.sort(), ['ds_1', 'ds_2', 'ds_3'], 'every visible dataset is asked about by tag');
  assert.deepEqual(out.get('ds_1'), { lastSync: '2026-11-13T06:01:00.000Z', syncStatus: 'ok' });
  assert.deepEqual(out.get('ds_2'), { lastSync: '2026-11-01T00:00:00.000Z', syncStatus: 'ok' });
  assert.deepEqual(out.get('ds_3'), { lastSync: null, syncStatus: null }, 'no run ⇒ an honest NEVER, no `unknown`');
});

test('latestSyncSignals: a Dagster outage is `unknown`, never reported as "never synced"', async () => {
  __setDataProjectGitForTests(true);
  const out = await latestSyncSignals(['ds_1'], {
    dagster: {
      nextTick: async () => ({ ok: false as const, error: 'unused' }),
      runsForDataset: async () => ({ ok: false as const, error: 'ECONNREFUSED' }),
    },
  });
  assert.deepEqual(out.get('ds_1'), { lastSync: null, syncStatus: null, unknown: true });
});

test('status mapping and trailing-failure counting', () => {
  assert.equal(runStatusToSync('SUCCESS'), 'ok');
  assert.equal(runStatusToSync('CANCELED'), 'error');
  assert.equal(runStatusToSync('QUEUED'), 'running');
  assert.equal(consecutiveFailures([run({ status: 'FAILURE' }), run({ status: 'STARTED' }), run({ status: 'FAILURE' }), run({ status: 'SUCCESS' }), run({ status: 'FAILURE' })]), 2);
  assert.equal(runToView(run({ tags: { 'os/full_refresh': 'true' } }), 'append').mode, 'full-refresh');
  assert.equal(runToView(run({ tags: { 'os/action': 'iceberg maintenance' } }), 'append').maintenance, true);
});

test('latestSyncSignals flag OFF: `lastSync` is startedAt, exactly as before B2', async () => {
  // Review B2-review-M6b: B2-8 redefined `lastSync` as "when the run ENDED". That reading belongs
  // to the Dagster path; on an install that is not using Dagster at all the number must not move.
  __setDataProjectGitForTests(false);
  recordSyncRun({
    datasetId: 'ds_1', startedAt: '2026-11-13T06:00:00.000Z', finishedAt: '2026-11-13T06:09:00.000Z',
    status: 'ok', mode: 'append',
  });
  const out = await latestSyncSignals(['ds_1'], {});
  assert.deepEqual(out.get('ds_1'), { lastSync: '2026-11-13T06:00:00.000Z', syncStatus: 'ok' });
});
