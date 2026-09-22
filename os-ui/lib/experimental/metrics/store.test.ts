/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __resetStore, createDataset, buildVersion, defineMeasure, transition, type Principal } from '../data/store.ts';
import { listMetrics, getMetric, safeSummariesFor } from './store.ts';

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
  // #155: a NEW dataset's member carries the domain-namespaced view (`sales__Orders`).
  assert.equal(rev!.member, 'sales__Orders.revenue');
  assert.equal(rev!.tier, 'domain'); // asset → domain
});

test('getMetric resolves datasetId.measure into a record', () => {
  const id = seedRevenueMetric();
  const rec = getMetric(`${id}.revenue`, amir);
  assert.equal(rec.measure.name, 'revenue');
  assert.equal(rec.member, 'sales__Orders.revenue'); // #155: namespaced view member
});

test('#91 FAIL-SOFT: a broken model yields an inline-error summary, never a throw', () => {
  // A datasetId that can't be read (removed/invalid) models a bad cube: safeSummariesFor
  // must return ONE error-tile summary instead of throwing, so listMetrics keeps rendering.
  seedRevenueMetric();
  let out: ReturnType<typeof safeSummariesFor> | null = null;
  assert.doesNotThrow(() => { out = safeSummariesFor('ds_does_not_exist', amir); });
  assert.equal(out!.length, 1);
  assert.equal(out![0].type, 'error');
  assert.ok(out![0].error, 'the tile carries the inline reason');
});

test('#91 FAIL-SOFT: listMetrics renders the good metrics even alongside a bad model', () => {
  // The good Revenue metric must still list; a bad one would render as an error tile,
  // never a 500 — one bad cube can never take down the whole surface.
  seedRevenueMetric();
  let groups: ReturnType<typeof listMetrics> | null = null;
  assert.doesNotThrow(() => { groups = listMetrics(amir); });
  const all = [...groups!.mine, ...groups!.domain, ...groups!.marketplace];
  assert.ok(all.find((m) => m.name === 'revenue' && !m.error), 'the healthy metric still renders');
});

test('MetricSummary.id is always "${datasetId}.${measureName}" so Monitor/explore can split it', () => {
  // Regression for the Monitor "Dataset not found" bug: the MetricBuilder used to set
  // `id = result.measure.name` (just "revenue") on a freshly-defined metric; getMetric
  // then split on the last dot → datasetId = "revenu" → getDataset threw 404. The id
  // MUST carry the full "${datasetId}.${measureName}" format.
  const id = seedRevenueMetric();
  const groups = listMetrics(amir);
  const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
  const rev = all.find((m) => m.name === 'revenue');
  assert.ok(rev, 'revenue metric is listed');
  // id must be "$datasetId.$measureName" — NOT bare "revenue".
  assert.equal(rev!.id, `${id}.revenue`, 'metric id is datasetId.measureName');
  // Splitting on the last dot must recover the correct dataset id.
  const lastDot = rev!.id.lastIndexOf('.');
  assert.equal(rev!.id.slice(0, lastDot), id, 'slice(0, lastDot) yields the dataset id');
  // getMetric must round-trip cleanly (no "Dataset not found").
  const rec = getMetric(rev!.id, amir);
  assert.equal(rec.measure.name, 'revenue');
});
