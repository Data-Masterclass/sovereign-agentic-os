/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Schedules and sensors paused in Dagster are visible in Monitoring, never changed by the OS
 * USER STORY: As a platform engineer I pause a schedule in the Dagster UI. The OS must show it as
 *             paused in Dagster and leave it alone. A stopped OS failure sensor is a warning.
 * ARCHITECTURE: pure over Dagster's own instigation states. Only schedules the OS expects to run
 *             (sync enabled) are reported when STOPPED, because a STOPPED schedule of a disabled
 *             sync is the intended state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dagsterStateItems, dagsterStateAlerts, type InstigatorState } from '@tabs/monitoring/lib/dagster-state-core';

const sch = (name: string, status: string): InstigatorState => ({ kind: 'schedule', name, status });
const sen = (name: string, status: string): InstigatorState => ({ kind: 'sensor', name, status });

test('a STOPPED schedule the OS expects to run is one amber item that says Dagster owns it', () => {
  const items = dagsterStateItems([sch('sales__ds_1', 'STOPPED'), sch('sales__ds_2', 'RUNNING')], new Map([['sales__ds_1', { domain: 'sales', owner: 'bea', datasetId: 'ds_1' }], ['sales__ds_2', { domain: 'sales', owner: 'bea', datasetId: 'ds_2' }]]));
  assert.equal(items.length, 1);
  assert.equal(items[0].health, 'amber');
  assert.equal(items[0].lens, 'pipelines');
  assert.equal(items[0].domain, 'sales');
  assert.match(items[0].detail, /paused in Dagster/i);
  assert.match(items[0].detail, /resume it in Dagster/i);
});

test('twin: a STOPPED schedule the OS does not expect (sync disabled) or does not know raises nothing', () => {
  assert.deepEqual(dagsterStateItems([sch('sales__ds_3', 'STOPPED'), sch('ops_maintenance', 'STOPPED')], new Map()), []);
});

test('a stopped OS failure or principals sensor is a warning; running sensors and foreign sensors are not', () => {
  const a = dagsterStateAlerts([sen('os_quarantine', 'STOPPED'), sen('os_principals', 'RUNNING'), sen('my_own_sensor', 'STOPPED')]);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warning');
  assert.match(a[0].title, /os_quarantine/);
  assert.match(a[0].detail, /does not restart/i);
});

test('an unreadable Dagster is not "nothing paused"', () => {
  const a = dagsterStateAlerts(null, 'timeout');
  assert.equal(a.length, 1);
  assert.match(a[0].detail, /timeout/);
});
