/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dataset, Measure } from '../data/dataset-schema.ts';
import { deregisterPlan, deregisterCubeMembers } from './physical-delete.ts';

// deregisterPlan reads only name/domain (via cubeName/cubeViewName/measureMember); a
// minimal cast keeps the planner test free of the full dataset builder.
function ds(): Dataset {
  return { id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales' } as unknown as Dataset;
}

const revenue: Measure = { name: 'revenue', type: 'sum', sql: 'net_amount' };

test('deregisterPlan: one Cube member per metric (its canonical member + cube)', () => {
  const plan = deregisterPlan(ds(), revenue);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].member, 'Orders.revenue');
  assert.equal(plan[0].measure, 'revenue');
  assert.equal(plan[0].cube, 'orders');
});

test('deregisterCubeMembers: DELETE physically removes the measure — reports ok', () => {
  const calls: { datasetId: string; measure: string }[] = [];
  const report = deregisterCubeMembers('ds_orders', ds(), revenue, (datasetId, measure) => {
    calls.push({ datasetId, measure });
    return { removed: true };
  });
  assert.deepEqual(calls, [{ datasetId: 'ds_orders', measure: 'revenue' }]);
  assert.equal(report.length, 1);
  assert.equal(report[0].target, 'Orders.revenue');
  assert.equal(report[0].ok, true);
  assert.match(report[0].reason, /de-registered from Cube model/);
});

test('deregisterCubeMembers: honest when the measure was already absent (removed=false)', () => {
  const report = deregisterCubeMembers('ds_orders', ds(), revenue, () => ({ removed: false }));
  assert.equal(report[0].ok, false);
  assert.match(report[0].reason, /already absent/);
});

test('deregisterCubeMembers: honest when de-registration throws (e.g. not permitted)', () => {
  const report = deregisterCubeMembers('ds_orders', ds(), revenue, () => {
    throw new Error('Not permitted to edit this dataset');
  });
  assert.equal(report[0].ok, false);
  assert.match(report[0].reason, /Not permitted/);
});
