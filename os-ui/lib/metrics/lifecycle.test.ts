/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createDataset,
  buildVersion,
  defineMeasure,
  transition,
  getDataset,
  type Principal,
} from '../data/store.ts';
import { buildCubeModels } from '../data/cube-models.ts';
import { listMetrics } from './store.ts';
import {
  __resetLifecycle,
  archiveMetric,
  unarchiveMetric,
  deleteMetric,
  listMetricVersions,
  restoreMetricVersion,
  isMetricArchived,
  moveMetric,
  metricFolder,
} from './lifecycle.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };
const mallory: Principal = { id: 'mallory', domains: ['ops'], role: 'builder' };

/** Build "Orders" to a Gold asset with a Revenue measure; return its id. */
function seed(): string {
  __resetStore();
  __resetLifecycle();
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  transition(d.id, amir, 'promote'); // dataset → asset (deliverable to Cube)
  defineMeasure(d.id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  return d.id;
}

function cubeMeasuresFor(datasetId: string): string[] {
  const d = getDataset(datasetId, amir);
  const payload = buildCubeModels([d]);
  const model = payload.models.find((m) => m.name === 'orders');
  return model?.measures ?? [];
}

test('MOVE puts a metric in a folder (rides the overlay); folder survives archive/restore', () => {
  const id = seed();
  const mid = `${id}.revenue`;
  assert.equal(metricFolder(mid), '/', 'a fresh metric is at the root');
  moveMetric(mid, amir, 'north-star/');
  assert.equal(metricFolder(mid), '/north-star', 'moved + normalised');
  // Archiving must NOT lose the folder (writeFlag preserves the other half of the overlay).
  archiveMetric(mid, amir);
  assert.equal(metricFolder(mid), '/north-star', 'folder survives archive');
  unarchiveMetric(mid, amir);
  assert.equal(metricFolder(mid), '/north-star', 'folder survives restore');
  // And the folder surfaces on the registry summary.
  const groups = listMetrics(amir);
  const summary = [...groups.mine, ...groups.domain, ...groups.marketplace].find((m) => m.id === mid);
  assert.equal(summary?.folder, '/north-star');
});

test('MOVE is edit-scoped — a non-owner from another domain is rejected', () => {
  const id = seed();
  assert.throws(
    () => moveMetric(`${id}.revenue`, mallory, '/theirs'),
    (e: unknown) => (e as { status?: number }).status === 403 || (e as { status?: number }).status === 404,
  );
});

test('DELETE physically de-registers the measure from the Cube model + honest report', () => {
  const id = seed();
  assert.deepEqual(cubeMeasuresFor(id), ['revenue'], 'revenue is a delivered Cube measure before delete');

  const report = deleteMetric(`${id}.revenue`, amir);
  assert.equal(report.recordDeleted, true);
  assert.equal(report.physical.length, 1);
  assert.equal(report.physical[0].target, 'Orders.revenue');
  assert.equal(report.physical[0].ok, true);

  // Physical de-registration: the measure is gone from /api/cube/models (falls back to
  // the YAML default `count` once there are no measures) — it stops being queryable.
  assert.deepEqual(cubeMeasuresFor(id), ['count'], 'revenue no longer delivered to Cube');
  assert.equal(getDataset(id, amir).measures.length, 0, 'measure physically removed from dataset');
});

test('ARCHIVE hides the metric but KEEPS the Cube model (reversible, not physical)', () => {
  const id = seed();
  archiveMetric(`${id}.revenue`, amir);
  assert.equal(isMetricArchived(`${id}.revenue`), true);

  // Hidden from the default list...
  const shown = listMetrics(amir);
  assert.equal([...shown.mine, ...shown.domain].some((m) => m.id === `${id}.revenue`), false);
  // ...but still visible with includeArchived, and the Cube measure is UNTOUCHED.
  const withArchived = listMetrics(amir, { includeArchived: true });
  assert.equal([...withArchived.mine, ...withArchived.domain].some((m) => m.id === `${id}.revenue`), true);
  assert.deepEqual(cubeMeasuresFor(id), ['revenue'], 'archive did NOT physically de-register');

  unarchiveMetric(`${id}.revenue`, amir);
  assert.equal(isMetricArchived(`${id}.revenue`), false);
});

test('DELETE is restorable — the measure is snapshotted and can be re-defined', () => {
  const id = seed();
  deleteMetric(`${id}.revenue`, amir);
  assert.equal(getDataset(id, amir).measures.length, 0);

  const history = listMetricVersions(`${id}.revenue`, amir);
  assert.ok(history.length >= 1, 'delete captured a version snapshot');

  restoreMetricVersion(`${id}.revenue`, amir, 1);
  assert.deepEqual(cubeMeasuresFor(id), ['revenue'], 'restore re-delivers the measure to Cube');
});

test('lifecycle is edit-scoped — a non-owner outside the domain cannot archive/delete', () => {
  const id = seed();
  assert.throws(() => archiveMetric(`${id}.revenue`, mallory), /not permitted/i);
  assert.throws(() => deleteMetric(`${id}.revenue`, mallory), /not permitted/i);
});
