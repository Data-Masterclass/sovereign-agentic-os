/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Monitoring Data panel's Dagster reads on a REAL dagster-webserver (1.13.31, the OS
 *             image's pin): run health per job and schedule, check-execution history, downstream
 *             assets from Dagster's own lineage.
 * USER STORY: As a data engineer I want job health, the quality trend and "what is impacted
 *             downstream" to be what Dagster itself records.
 * ARCHITECTURE:
 *   - tests/monitoring/up.sh: pip-installed dagster-webserver over tests/monitoring/dagster/defs.py,
 *     seeded by seed.py with real runs (a passing then failing check, a failing job, a run of a
 *     dataset outside the caller's set).
 *   - Negative twins: the out-of-scope dataset's run is not in the job health; an asset with no
 *     dependents has no downstream; a dead port is ok:false.
 *   - Run: MON_IT=1 node --import ./scripts/test-setup.mjs --test core/adapters/dagster/monitoring-read.int.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentOsRuns } from '@core/infra/dagster';
import { checkExecutions, dependedByGraph, downstreamOf, jobHealthOf } from './monitoring-read';

const on = process.env.MON_IT === '1';
const deps = { url: process.env.MON_DAGSTER_URL ?? 'http://127.0.0.1:13570', timeoutMs: 10_000 };

test('job and schedule health per dataset from Dagster runs; another dataset is not listed', { skip: !on }, async () => {
  const runs = await recentOsRuns(100, deps);
  assert.ok(runs.ok, JSON.stringify(runs));
  const health = jobHealthOf(runs.data, ['orders']);
  const orders = health.get('orders');
  assert.ok(orders, 'no health for orders');
  const dbt = orders.jobs.find((j) => j.name === 'sales_dbt');
  const broken = orders.jobs.find((j) => j.name === 'sales__broken');
  assert.ok(dbt && broken, JSON.stringify(orders.jobs));
  assert.equal(dbt.lastStatus, 'SUCCESS');
  assert.ok(dbt.lastSuccessAt);
  assert.equal(dbt.runs, 2);
  assert.equal(broken.lastStatus, 'FAILURE');
  assert.equal(broken.lastSuccessAt, null);
  assert.equal(broken.failures, 1);
  const sched = orders.schedules.find((s) => s.name === 'sales__orders_schedule');
  assert.ok(sched && sched.lastSuccessAt, JSON.stringify(orders.schedules));
  // Negative twin: secret_ds ran too, but was not asked for.
  assert.equal(health.has('secret_ds'), false);
  assert.ok(!orders.jobs.some((j) => j.runIds.some((id) => runs.data.find((r) => r.runId === id)?.tags['os/dataset'] !== 'orders')));
});

test('check executions come back newest first with pass/fail from Dagster', { skip: !on }, async () => {
  const ex = await checkExecutions(['sales', 'orders'], 'not_null_orders_id', 10, deps);
  assert.ok(ex.ok, JSON.stringify(ex));
  assert.ok(ex.data.length >= 2);
  assert.equal(ex.data[0].passed, false, 'the newest execution failed');
  assert.equal(ex.data.at(-1)!.passed, true, 'the oldest execution passed');
  assert.ok(ex.data.every((e) => e.runId && e.at));
});

test('downstream assets are the transitive closure of Dagster’s dependedByKeys', { skip: !on }, async () => {
  const g = await dependedByGraph(deps);
  assert.ok(g.ok, JSON.stringify(g));
  assert.deepEqual(downstreamOf(g.data, [['sales', 'stg_orders']]), [['sales', 'orders'], ['sales', 'orders_mart']]);
  assert.deepEqual(downstreamOf(g.data, [['sales', 'orders_mart']]), []);
  const down = await dependedByGraph({ url: 'http://127.0.0.1:1', timeoutMs: 1000 });
  assert.equal(down.ok, false);
});
