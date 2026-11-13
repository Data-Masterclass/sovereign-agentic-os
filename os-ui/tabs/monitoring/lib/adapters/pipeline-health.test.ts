/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring's pipeline lens reads Dagster runs by their `os/*` tags
 * USER STORY: As an operator I want a pipeline row to name the DATASET, its domain, its principal
 *             and the commit the run materialised — and an untagged run to keep its job name
 *             instead of being hidden or mislabelled.
 * ARCHITECTURE: `runToItem` is pure over one `DagsterRun`; `collectPipelines`'s fetch is not
 *               exercised here (the typed client has its own fake-fetch suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToItem } from '@tabs/monitoring/lib/adapters/pipeline-health';
import type { DagsterRun } from '@core/infra/dagster';

function run(over: Partial<DagsterRun> = {}): DagsterRun {
  return {
    runId: 'r1', status: 'SUCCESS', jobName: 'sales__ds_1',
    startedAt: '2026-11-13T06:00:00.000Z', endedAt: '2026-11-13T06:01:00.000Z',
    tags: {}, assetSelection: [], ...over,
  };
}

test('an OS-tagged run names the dataset, action, commit, domain and principal', () => {
  const item = runToItem(run({
    tags: { 'os/dataset': 'ds_1', 'os/domain': 'sales', 'os/principal': 'bea', 'os/action': 'scheduled sync', 'os/commit': 'abcdef1234567890' },
    assetSelection: ['sales/silver_events', 'sales/gold_mart'],
  }));
  assert.equal(item.id, 'pl-r1');
  assert.equal(item.lens, 'pipelines');
  assert.equal(item.title, 'ds_1 — scheduled sync @ abcdef1');
  assert.equal(item.health, 'green');
  assert.equal(item.domain, 'sales');
  assert.equal(item.owner, 'bea');
  assert.equal(item.ts, '2026-11-13T06:00:00.000Z');
  assert.match(item.detail, /as bea/);
  assert.match(item.detail, /sales\/silver_events, sales\/gold_mart/);
  assert.equal(item.source, 'live');
});

test('an untagged run keeps its job name; statuses map to the lens health vocabulary', () => {
  assert.equal(runToItem(run({ jobName: 'sovereign_demo_dbt' })).title, 'sovereign_demo_dbt — Dagster run');
  assert.equal(runToItem(run({ jobName: '' })).title, 'pipeline — Dagster run');
  assert.equal(runToItem(run()).domain, 'platform');
  assert.equal(runToItem(run({ status: 'FAILURE' })).health, 'red');
  assert.equal(runToItem(run({ status: 'CANCELED' })).health, 'red');
  assert.equal(runToItem(run({ status: 'STARTED' })).health, 'amber');
  assert.equal(runToItem(run({ status: 'QUEUED' })).health, 'amber');
  assert.equal(runToItem(run({ status: 'NOT_STARTED' })).health, 'unknown');
});
