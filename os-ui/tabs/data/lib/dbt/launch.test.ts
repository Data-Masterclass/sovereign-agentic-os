/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Commit-then-launch, the scheduler hand-over and "sync now" under the flag
 * USER STORY: As a maintainer I want proof that a Build launches exactly ONE Dagster run per
 *             commit, for the right asset subset, with the OS tags and the run pod's
 *             `OS_PRINCIPAL` / `OS_PINNED_COMMITS`; that a retry re-uses the failed run's batch
 *             id; that every failure is recorded on the version instead of thrown; and that with
 *             the flag OFF nothing reaches Dagster and the CronJob path is untouched.
 * ARCHITECTURE: the real store seeded as in commit.test.ts; every Dagster call and the recorder
 *               injected, so no network and no git.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '@tabs/data/lib/store';
import type { Principal } from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { __setDataProjectGitForTests } from '@tabs/data/lib/dbt/commit';
import {
  launchAfterCommit, launchDatasetBuild, newBatchId, batchIdForRetry, waitForAssets,
  reconcileSyncSchedule, runSyncNow, type LaunchDeps,
} from '@tabs/data/lib/dbt/launch';
import type { DagsterRun } from '@core/infra/dagster';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const SHA = 'a'.repeat(40);

type Launched = { domain?: string; selection?: string[][]; tags?: Record<string, string>; env?: Record<string, string> };
let launches: Launched[] = [];
let recorded: { id: string; layer: string; run: Record<string, unknown> }[] = [];

function fakeDagster(over: Partial<LaunchDeps['dagster'] & object> = {}) {
  return {
    launchRun: async (input: Launched) => {
      launches.push(input);
      return { ok: true as const, data: { runId: 'run_1', status: 'QUEUED' as const } };
    },
    assetGraph: async () => ({ ok: true as const, data: [
      { key: ['sales', 'silver_orders'], dependsOn: [], group: 'sales', description: null },
      { key: ['sales', 'gold_orders'], dependsOn: [], group: 'sales', description: null },
    ] }),
    runsForDataset: async () => ({ ok: true as const, data: [] as DagsterRun[] }),
    ...over,
  };
}

function deps(over: Partial<LaunchDeps> = {}): LaunchDeps {
  return {
    dagster: fakeDagster(),
    head: async () => SHA,
    awaitCommits: async () => {},
    record: ((id: string, layer: string, run: Record<string, unknown>) => {
      recorded.push({ id, layer, run });
      return null as never;
    }) as unknown as LaunchDeps['record'],
    sleep: async () => {},
    waitMs: 0,
    ...over,
  };
}

function seedOrders(): string {
  const d = store.createDataset(amir, { name: 'Orders' });
  store.buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  store.buildVersion(d.id, amir, 'silver', {
    quality: 'passing', artifact: 'silver/stg_orders.sql', compiled: true,
    body: 'create or replace table iceberg.personal_amir.silver_orders as select * from iceberg.personal_amir.bronze_orders',
  });
  return d.id;
}

beforeEach(() => {
  store.__resetStore();
  __resetProjectListeners();
  launches = [];
  recorded = [];
});
afterEach(() => __setDataProjectGitForTests(null));

test('launchAfterCommit: ONE run per commit, the dataset subset, the OS tags and the run-pod env', async () => {
  __setDataProjectGitForTests(true);
  const id = seedOrders();
  const out = await launchAfterCommit(
    { datasetId: id, layer: 'silver', kind: 'build', actor: { id: 'amir' }, principal: 'amir', action: 'transform silver', surface: 'ui:data' },
    deps(),
  );
  assert.equal(launches.length, 1);
  assert.equal(out.dagsterRunId, 'run_1');
  assert.equal(out.launchError, null);
  assert.equal(out.commit, SHA);
  assert.deepEqual(launches[0].selection, [['sales', 'silver_orders']]);
  assert.equal(launches[0].domain, 'sales');
  assert.deepEqual(launches[0].env, { OS_PRINCIPAL: 'amir', OS_PINNED_COMMITS: `sales=${SHA}` });
  assert.deepEqual(launches[0].tags, {
    'os/dataset': id, 'os/domain': 'sales', 'os/principal': 'amir', 'os/user': 'amir',
    'os/action': 'transform silver', 'os/layer': 'silver', 'os/commit': SHA, 'os/surface': 'ui:data',
  });
  assert.deepEqual(recorded, [{ id, layer: 'silver', run: { commit: SHA, dagsterRunId: 'run_1', launchError: null } }]);
});

test('every refusal is RECORDED on the version, never thrown: no commit, no model, Dagster down', async () => {
  __setDataProjectGitForTests(true);
  const id = seedOrders();

  const noCommit = await launchAfterCommit({ datasetId: id, layer: 'silver', kind: 'build', actor: { id: 'amir' }, principal: 'amir', action: 'x' }, deps({ head: async () => null }));
  assert.equal(noCommit.dagsterRunId, null);
  assert.match(noCommit.launchError!, /no commit on the domain repository/);
  assert.equal(launches.length, 0);

  const down = await launchAfterCommit({ datasetId: id, layer: 'silver', kind: 'build', actor: { id: 'amir' }, principal: 'amir', action: 'x' },
    deps({ dagster: fakeDagster({ assetGraph: async () => ({ ok: false as const, error: 'HTTP 503' }) }) }));
  assert.match(down.launchError!, /not launched: Dagster unreachable: HTTP 503/);
  assert.equal(launches.length, 0);

  const refused = await launchAfterCommit({ datasetId: id, layer: 'silver', kind: 'build', actor: { id: 'amir' }, principal: 'amir', action: 'x' },
    deps({ dagster: fakeDagster({ launchRun: async () => ({ ok: false as const, error: 'InvalidSubsetError: nope' }) }) }));
  assert.match(refused.launchError!, /not launched: InvalidSubsetError: nope/);

  const missing = await launchAfterCommit({ datasetId: 'ds_nope', layer: 'silver', kind: 'build', actor: { id: 'amir' }, principal: 'amir', action: 'x' }, deps());
  assert.equal(missing.launchError, 'dataset not found');
  assert.equal(recorded.length, 3, 'a missing dataset has no version to record on');
});

test('a layer with no dbt model (built out of band) is not launched, and says why', async () => {
  __setDataProjectGitForTests(true);
  const d = store.createDataset(amir, { name: 'Authored' });
  store.buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/a.yml' });
  store.buildVersion(d.id, amir, 'silver', { quality: 'unknown', artifact: 'silver/a.sql', body: 'select 1' }); // no `compiled`
  const out = await launchAfterCommit({ datasetId: d.id, layer: 'silver', kind: 'build', actor: { id: 'amir' }, principal: 'amir', action: 'x' }, deps());
  assert.equal(out.dagsterRunId, null);
  assert.match(out.launchError!, /no dbt model for silver/);
  assert.equal(launches.length, 0);
});

test('a sync run carries a batch id; a RETRY re-uses the failed run’s, a fresh run mints one', async () => {
  const at = new Date('2026-11-13T08:45:12Z');
  assert.equal(newBatchId('ds_1', at), 'b_ds_1_202611130845');
  const failed: DagsterRun[] = [{ runId: 'r2', status: 'FAILURE', jobName: 'j', startedAt: null, endedAt: null, tags: { 'os/batch_id': 'b_old' }, assetSelection: [] }];
  assert.equal(await batchIdForRetry('ds_1', failed, at), 'b_old');
  const ok: DagsterRun[] = [{ ...failed[0], status: 'SUCCESS' }];
  assert.equal(await batchIdForRetry('ds_1', ok, at), 'b_ds_1_202611130845');
  const running: DagsterRun[] = [{ ...failed[0], status: 'STARTED' }, ...failed];
  assert.equal(await batchIdForRetry('ds_1', running, at), 'b_old', 'an in-flight run is stepped over');
  assert.equal(await batchIdForRetry('ds_1', [], at), 'b_ds_1_202611130845');
});

test('waitForAssets reports the keys the location does not expose yet', async () => {
  const r = await waitForAssets([['sales', 'silver_orders'], ['sales', 'gold_new']], deps());
  assert.deepEqual(r.missing, [['sales', 'gold_new']]);
  assert.match(r.error!, /not in the location yet: sales\/gold_new/);
  const ok = await waitForAssets([['sales', 'silver_orders']], deps());
  assert.deepEqual(ok, { missing: [], error: null });
});

test('flag OFF: launchDatasetBuild is a no-op and nothing reaches Dagster', async () => {
  __setDataProjectGitForTests(false);
  const id = seedOrders();
  assert.equal(launchDatasetBuild({ datasetId: id, layer: 'silver', actor: { id: 'amir' }, principal: 'amir', action: 'x' }, deps()), false);
  assert.equal(launches.length, 0);
  assert.equal(recorded.length, 0);
});

test('reconcileSyncSchedule: the CronJob with the flag off, Dagster (and CronJob cleanup) with it on', async () => {
  const cronCalls: (null | { enabled: boolean })[] = [];
  const cron = (async (_id: string, sync: { enabled: boolean } | null) => {
    cronCalls.push(sync);
    return { ok: true as const, live: true, action: 'deleted' as const, name: 'data-sync-ds_1', detail: 'gone' };
  }) as never;

  __setDataProjectGitForTests(false);
  const off = await reconcileSyncSchedule('ds_1', { enabled: true, schedule: { cron: '0 6 * * *' } }, { cron });
  assert.deepEqual(cronCalls, [{ enabled: true, schedule: { cron: '0 6 * * *' } }]);
  assert.equal(off.detail, 'gone');

  cronCalls.length = 0;
  __setDataProjectGitForTests(true);
  const on = await reconcileSyncSchedule('ds_1', { enabled: true, schedule: { cron: '0 6 * * *' } }, { cron });
  assert.deepEqual(cronCalls, [null], 'the flag-on path only REMOVES a pre-B2 CronJob');
  assert.match(on.detail, /Dagster schedules this sync from the domain repository/);
  assert.match(on.detail, /pre-B2 CronJob data-sync-ds_1 was removed/);
  assert.equal(on.ok, true);
});

test('runSyncNow with the flag on launches Dagster as the OWNER and writes no ledger row', async () => {
  __setDataProjectGitForTests(true);
  const id = seedOrders();
  const ran = await runSyncNow(id, 'reset', 'bea', deps());
  assert.equal(ran.mode, 'dagster');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].tags!['os/principal'], 'amir', 'the dataset owner, not the caller');
  assert.equal(launches[0].tags!['os/user'], 'bea');
  assert.equal(launches[0].tags!['os/full_refresh'], 'true');
  assert.match(launches[0].tags!['os/batch_id'], /^b_ds_/);
  assert.equal(launches[0].env!.OS_PRINCIPAL, 'amir');
});
