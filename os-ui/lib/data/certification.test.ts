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
  certify,
  requestCertification,
  applyApprovedCertification,
  importProduct,
  listImported,
  listDatasets,
  getDataset,
  transition,
  type Principal,
} from './store.ts';
import { DatasetError } from './dataset-schema.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'participant' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const maria: Principal = { id: 'maria', domains: ['finance'], role: 'admin' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'participant' };

beforeEach(() => __resetStore());

/** A documented Silver asset in sales (promoted), ready to certify. */
function salesAsset(): string {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  setDocs(d.id, amir, { description: 'Sales orders.', columns: [{ name: 'order_id', description: 'Key.' }] });
  const req = requestPromotion(d.id, amir, { visibility: 'domain' });
  applyApprovedPromotion(req, bea);
  return d.id;
}

test('only an Admin certifies an asset → product (Builder cannot)', () => {
  const id = salesAsset();
  assert.throws(() => certify(id, bea, {}), (e: DatasetError) => e.status === 403); // Builder
  const product = certify(id, sara, { level: 'gold', visibility: 'shared' });
  assert.equal(product.tier, 'product');
  assert.equal(product.certification?.level, 'gold');
  assert.equal(product.certification?.by, 'sara');
});

test('certification is by an Admin in the asset’s domain, not a foreign Admin', () => {
  const id = salesAsset();
  assert.throws(() => certify(id, maria, {}), (e: DatasetError) => e.status === 403); // finance admin
});

test('a certified product is listed in the marketplace for every domain', () => {
  const id = salesAsset();
  certify(id, sara, {});
  assert.equal(listDatasets(kenji).marketplace.some((x) => x.id === id), true);
});

test('request → approve certification (Admin approves a Builder/owner request)', () => {
  const id = salesAsset();
  const req = requestCertification(id, amir, { level: 'silver' }); // owner requests
  assert.throws(() => applyApprovedCertification(req, bea), (e: DatasetError) => e.status === 403); // Builder can't approve
  const product = applyApprovedCertification(req, sara);
  assert.equal(product.tier, 'product');
  assert.equal(product.certification?.level, 'silver');
});

test('import/subscribe records the domain + adds a read grant (idempotent)', () => {
  const id = salesAsset();
  certify(id, sara, {});
  const p1 = importProduct(id, kenji); // finance imports
  assert.ok(p1.imports?.includes('finance'));
  assert.ok(p1.grants.some((g) => g.grantee.kind === 'domain' && g.grantee.id === 'finance'));
  const p2 = importProduct(id, kenji); // again — no duplication
  assert.equal(p2.imports?.filter((x) => x === 'finance').length, 1);
  assert.equal(listImported(kenji).some((x) => x.id === id), true);
});

test('the owning domain cannot import its own product', () => {
  const id = salesAsset();
  certify(id, sara, {});
  assert.throws(() => importProduct(id, bea), (e: DatasetError) => e.status === 409); // sales owns it
});

test('lineage-aware: a product with importers cannot be decertified', () => {
  const id = salesAsset();
  certify(id, sara, {});
  importProduct(id, kenji);
  assert.throws(() => transition(id, sara, 'decertify'), (e: DatasetError) => e.status === 409);
});

test('decertify (no importers) returns to an asset and drops the badge', () => {
  const id = salesAsset();
  certify(id, sara, {});
  const asset = transition(id, sara, 'decertify');
  assert.equal(asset.tier, 'asset');
  assert.equal(asset.certification, undefined);
});

test('only an Admin decertifies; a Builder cannot', () => {
  const id = salesAsset();
  certify(id, sara, {});
  assert.throws(() => transition(id, bea, 'decertify'), (e: DatasetError) => e.status === 403);
});

test('unshare is blocked while named individuals are granted (lineage-aware)', () => {
  // Promote with a named cross-domain individual grant, then unshare must refuse.
  const d = createDataset(amir, { name: 'Leads' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'b' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 's' });
  setDocs(d.id, amir, { description: 'Leads.', columns: [{ name: 'id', description: 'Key.' }] });
  const req = requestPromotion(d.id, amir, {
    visibility: 'domain',
    grants: [{ grantee: { kind: 'user', id: 'kenji' }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }],
  });
  applyApprovedPromotion(req, bea);
  assert.throws(() => transition(d.id, sara, 'unshare'), (e: DatasetError) => e.status === 409);
});

test('unshare succeeds for a plain domain asset (no named individuals)', () => {
  const id = salesAsset(); // only a domain grant
  const back = transition(id, sara, 'unshare');
  assert.equal(back.tier, 'dataset');
});
