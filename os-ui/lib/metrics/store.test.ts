/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, defineMeasure, transition, type Principal } from '../data/store.ts';
import { listMetrics, getMetric } from './store.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'builder' };

/**
 * The data store ships EMPTY now. Build a private "Orders" dataset through the
 * public API, take it to a Gold asset, then define a Revenue measure. Returns
 * the dataset id (ids are generated, no longer the literal 'ds_orders').
 */
function seedRevenueMetric(): string {
  __resetStore();
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/orders.sql' });
  transition(d.id, amir, 'promote'); // dataset → asset (a domain metric)
  defineMeasure(d.id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  return d.id;
}

test('listMetrics groups a PERSONAL-tier metric under mine without crashing (personal→mine)', () => {
  // Reachable path: define Revenue on the asset, then unshare back to a private dataset —
  // the measure is retained, so the dataset is tier=dataset WITH a measure → tier
  // 'personal'. Before the fix this indexed out['personal'] (undefined) → TypeError/500.
  const id = seedRevenueMetric();
  transition(id, amir, 'unshare'); // asset → dataset, measure kept
  let groups: ReturnType<typeof listMetrics> | null = null;
  assert.doesNotThrow(() => { groups = listMetrics(amir); });
  const rev = groups!.mine.find((m) => m.name === 'revenue');
  assert.ok(rev, 'personal-tier revenue is grouped under "mine"');
  assert.equal(rev!.tier, 'personal');
});

test('a defined Revenue metric is listed with its canonical member', () => {
  seedRevenueMetric();
  const groups = listMetrics(amir);
  const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
  const rev = all.find((m) => m.name === 'revenue');
  assert.ok(rev, 'revenue metric is listed');
  assert.equal(rev!.member, 'Orders.revenue');
  assert.equal(rev!.tier, 'domain'); // asset → domain
});

test('getMetric resolves datasetId.measure into a record', () => {
  const id = seedRevenueMetric();
  const rec = getMetric(`${id}.revenue`, amir);
  assert.equal(rec.measure.name, 'revenue');
  assert.equal(rec.member, 'Orders.revenue');
});
