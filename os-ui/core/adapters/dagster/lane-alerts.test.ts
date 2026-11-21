/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Data shows a run that reached beyond its owner's lane
 * USER STORY: As an operator I want to SEE that a run selected a model its owner did not generate,
 *             not find a log line afterwards.
 * ARCHITECTURE: The code location tags such a run `os/lane_violation` (images/extensions/dagster/repo.py,
 *             the `os_lane_check` sensor); `laneAlertsOf` reads those tags from the runs the Data panel
 *             already fetches, for the datasets the viewer asked about only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneAlertsOf, visibleModels } from './monitoring-read';
import type { DagsterRun } from '@core/infra/dagster';

const run = (runId: string, tags: Record<string, string>): DagsterRun => ({ runId, status: 'SUCCESS', jobName: 'sales__all', startedAt: '2026-11-21T10:00:00.000Z', endedAt: null, tags, assetSelection: [] });

test('a run tagged os/lane_violation becomes an alert on its dataset, newest first', () => {
  const a = laneAlertsOf([
    run('r2', { 'os/dataset': 'ds_a', 'os/lane_violation': 'silver_b,forged', 'os/principal': 'bea' }),
    run('r1', { 'os/dataset': 'ds_a', 'os/lane_violation': 'silver_b', 'os/principal': 'bea' }),
  ], ['ds_a']);
  assert.deepEqual(a.get('ds_a')?.map((x) => [x.runId, x.models, x.principal]), [['r2', ['silver_b', 'forged'], 'bea'], ['r1', ['silver_b'], 'bea']]);
});

test('NEGATIVE TWINS: a clean run, an unasked dataset and a run without a dataset raise nothing', () => {
  const a = laneAlertsOf([
    run('c', { 'os/dataset': 'ds_a' }),
    run('o', { 'os/dataset': 'ds_other', 'os/lane_violation': 'x' }),
    run('n', { 'os/lane_violation': 'x' }),
  ], ['ds_a']);
  assert.equal(a.size, 0);
});

test('a hand-launched run without os/dataset is an alert on its domain, for viewers of that domain only', () => {
  const runs = [run('h', { 'os/domain': 'sales', 'os/lane_violation': 'silver_b', 'os/principal': 'bea' }), run('x', { 'os/domain': 'hr', 'os/lane_violation': 'y' })];
  const a = laneAlertsOf(runs, [], ['sales']);
  assert.deepEqual(a.get('domain:sales')?.map((x) => x.runId), ['h']);
  assert.equal(a.has('domain:hr'), false, 'another domain\'s run is not shown');
  assert.equal(laneAlertsOf(runs, [], []).size, 0, 'no domains, no alerts');
});

test('model names are filtered to what the viewer may see; the rest is a count', () => {
  const alert = { runId: 'r', models: ['silver_b', 'secret_model', 'forged'], principal: 'bea', at: null };
  const seen = visibleModels(alert, new Set(['silver_b']));
  assert.deepEqual(seen.models, ['silver_b']);
  assert.equal(seen.hidden, 2, 'two names withheld, only counted');
  assert.deepEqual(visibleModels(alert, new Set()).models, []);
});
