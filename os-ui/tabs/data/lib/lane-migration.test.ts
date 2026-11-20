/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Lane names: unique per dataset, within the identifier limit, and recordable
 * USER STORY: As an operator I want every existing dataset's lane name recorded without moving a
 *             table, and every lane table two datasets share listed, before anything changes.
 * ARCHITECTURE:
 *   - Pure tests of store-fqn's lane helpers and lane-migration's plan (no engine involved; the
 *     separation itself is proven on real Trino in lane-names.trino.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVersions, parseDataset, type Dataset } from '@tabs/data/lib/dataset-schema';
import { LANE_TABLE_MAX, laneSlug, newLaneSlug } from '@tabs/data/lib/store-fqn';
import { applyLaneRecords, planLaneRecords } from '@tabs/data/lib/lane-migration';

function ds(over: Partial<Dataset>): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true; versions.gold.built = true;
  return { version: '1', id: 'ds_a', name: 'Goods Receipts', owner: 'aborek', domain: 'a', tier: 'dataset', visibility: 'private', description: '', versions, grants: [], measures: [], columns: [], ...over };
}

test('newLaneSlug: readable name + dataset id, unique per dataset, within the identifier limit', () => {
  assert.equal(newLaneSlug('Northpeak Goods Receipts', 'ds_r0ejqrd65h'), 'northpeak_goods_receipts_r0ejqrd65h');
  assert.notEqual(newLaneSlug('Same', 'ds_1'), newLaneSlug('Same', 'ds_2'));
  const long = newLaneSlug('A very long dataset name that goes on and on and on forever', `ds_${'f'.repeat(32)}`);
  assert.ok(`bronze_${long}`.length <= LANE_TABLE_MAX, `bronze_${long}`);
  assert.ok(long.endsWith('f'.repeat(32)), 'the id is never cut');
});

test('plan: a legacy dataset records the lane name its tables ALREADY have; a recorded one is kept', () => {
  const plan = planLaneRecords([ds({ id: 'ds_old' }), ds({ id: 'ds_new', name: 'Other', laneSlug: 'other_new' })]);
  assert.deepEqual(plan.datasets.map((p) => [p.dataset, p.action, p.laneSlug]), [['ds_old', 'record', 'goods_receipts'], ['ds_new', 'keep', 'other_new']]);
  assert.deepEqual(plan.datasets[0].laneTables, ['iceberg.personal_aborek.bronze_goods_receipts', 'iceberg.personal_aborek.gold_goods_receipts']);
});

test('plan: a lane table two datasets map to (one name, two domains) is listed as a collision', () => {
  const plan = planLaneRecords([ds({ id: 'ds_asset', domain: 'q3', tier: 'asset' }), ds({ id: 'ds_draft', domain: 'aw' }), ds({ id: 'ds_x', owner: 'someone' })]);
  assert.deepEqual(plan.collisions.map((c) => [c.table, c.datasets.map((d) => d.id)]), [
    ['iceberg.personal_aborek.bronze_goods_receipts', ['ds_asset', 'ds_draft']],
    ['iceberg.personal_aborek.gold_goods_receipts', ['ds_asset', 'ds_draft']],
  ]);
});

test('apply: the records carry the lane name through the yaml round trip; nothing else is planned', () => {
  const list = [ds({ id: 'ds_old' }), ds({ id: 'ds_new', laneSlug: 'kept_x' })];
  const records = applyLaneRecords(list, planLaneRecords(list));
  assert.deepEqual(records.map((r) => r.id), ['ds_old']);
  assert.equal(laneSlug(parseDataset(records[0].yaml)), 'goods_receipts');
  assert.equal(parseDataset(records[0].yaml).laneSlug, 'goods_receipts', 'recorded explicitly, not derived');
});
