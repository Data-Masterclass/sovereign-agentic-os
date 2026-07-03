/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createDataset,
  buildVersion,
  setDocs,
  requestPromotion,
  applyApprovedPromotion,
  getDataset,
  assetTarget,
  type Principal,
} from './store.ts';
import { DatasetError } from './dataset-schema.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' }; // Creator
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };
const maria: Principal = { id: 'maria', domains: ['finance'], role: 'admin' };

beforeEach(() => __resetStore());

/** Build a documented, Silver-built dataset owned by amir (ready to request). */
function readyDataset(): string {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql', body: 'select * from raw' });
  setDocs(d.id, amir, { description: 'Sales orders.', columns: [{ name: 'order_id', description: 'Surrogate key.' }] });
  return d.id;
}

test('Creator requests promotion of their OWN documented dataset', () => {
  const id = readyDataset();
  const req = requestPromotion(id, amir, { visibility: 'domain' });
  assert.equal(req.datasetId, id);
  assert.equal(req.visibility, 'domain');
  assert.equal(req.target, assetTarget(getDataset(id, amir)));
  assert.match(req.target, /^iceberg\.sales\.silver_orders$/);
});

test('promotion request is blocked when the transparency gate is red', () => {
  const d = createDataset(amir, { name: 'Bare' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { artifact: 's' }); // built, but no docs
  assert.throws(() => requestPromotion(d.id, amir), /transparency gate|documentation/i);
});

test('Bronze-only data is not shareable', () => {
  const d = createDataset(amir, { name: 'RawOnly' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  setDocs(d.id, amir, { description: 'x', columns: [{ name: 'c', description: 'd' }] });
  assert.throws(() => requestPromotion(d.id, amir), /Silver or Gold/i);
});

test('a non-owner cannot request promotion of someone else’s dataset', () => {
  const id = readyDataset();
  assert.throws(() => requestPromotion(id, bea), (e: DatasetError) => e.status === 403);
});

test('the Creator→Builder handoff: a domain Builder approves a dataset they do NOT own', () => {
  const id = readyDataset();
  const req = requestPromotion(id, amir, { visibility: 'domain' });
  // bea is a Builder in sales, not the owner — the approval is the authorization.
  const asset = applyApprovedPromotion(req, bea);
  assert.equal(asset.tier, 'asset');
  assert.equal(asset.visibility, 'domain');
  // now a sales peer can view it; amir still owns it
  assert.equal(getDataset(id, bea).tier, 'asset');
});

test('separation of duties holds on approval: a Creator cannot approve', () => {
  const id = readyDataset();
  const req = requestPromotion(id, amir);
  // amir is the owner but only a participant — cannot self-promote via approval either
  assert.throws(() => applyApprovedPromotion(req, amir), (e: DatasetError) => e.status === 403);
});

test('cross-domain Builder/Admin cannot approve another domain’s promotion', () => {
  const id = readyDataset();
  const req = requestPromotion(id, amir);
  assert.throws(() => applyApprovedPromotion(req, maria), (e: DatasetError) => e.status === 403); // finance admin
  assert.throws(() => applyApprovedPromotion(req, kenji), (e: DatasetError) => e.status === 403);
});

test('double-apply is rejected once the dataset is already an asset', () => {
  const id = readyDataset();
  const req = requestPromotion(id, amir);
  applyApprovedPromotion(req, bea);
  assert.throws(() => applyApprovedPromotion(req, bea), (e: DatasetError) => e.status === 409);
});
