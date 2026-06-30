/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  listDatasets,
  getDataset,
  createDataset,
  buildVersion,
  defineMeasure,
  transition,
  listFiles,
  writeFile,
  type Principal,
} from './store.ts';
import { DatasetError } from './dataset-schema.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'participant' }; // Creator
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'participant' };

beforeEach(() => __resetStore());

test('seeds the Orders worked example as a private dataset for amir', () => {
  const groups = listDatasets(amir);
  assert.equal(groups.mine.length, 1);
  assert.equal(groups.mine[0].name, 'Orders');
  assert.deepEqual(groups.mine[0].dots, { bronze: true, silver: true, gold: false });
});

test('private dataset is owner-only — another user cannot see or open it', () => {
  assert.equal(listDatasets(kenji).mine.length, 0);
  assert.equal(listDatasets(kenji).domain.length, 0);
  assert.throws(() => getDataset('ds_orders', kenji), (e: DatasetError) => e.status === 403);
});

test('create + build versions; tile dots and quality reflect the furthest layer', () => {
  const d = createDataset(amir, { name: 'Web traffic' });
  assert.equal(d.tier, 'dataset');
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/web.dlt.yml' });
  const after = getDataset(d.id, amir);
  assert.equal(after.versions.bronze.built, true);
  const mine = listDatasets(amir).mine.find((x) => x.id === d.id)!;
  assert.deepEqual(mine.dots, { bronze: true, silver: false, gold: false });
});

test('Creator cannot promote; Builder promotes dataset -> asset (into Trino)', () => {
  // amir (Creator) is blocked
  assert.throws(() => transition('ds_orders', amir, 'promote'), (e: DatasetError) => e.status === 403);
  // bea (Builder, same domain, admin-or-owner edit rule) — give her edit via admin? No:
  // promotion edit-rights: bea is not owner nor admin, so she cannot edit amir's dataset.
  // The realistic flow: an admin/owner promotes. Use sara (admin) to exercise the gate move,
  // and separately prove the ROLE gate via canTransition-backed path below.
  const promoted = transition('ds_orders', sara, 'promote', { visibility: 'domain' });
  assert.equal(promoted.tier, 'asset');
  assert.equal(promoted.visibility, 'domain');
});

test('Builder role gate: a builder may promote, but only data they can edit', () => {
  // Build a dataset owned by bea so she can edit it, then promote as Builder.
  const d = createDataset(bea, { name: 'Leads' });
  const promoted = transition(d.id, bea, 'promote', { visibility: 'domain' });
  assert.equal(promoted.tier, 'asset');
  // A builder cannot certify (admin-only).
  assert.throws(() => transition(d.id, bea, 'certify'), (e: DatasetError) => e.status === 403);
});

test('only Admin certifies asset -> product; product is marketplace-discoverable', () => {
  transition('ds_orders', sara, 'promote', { visibility: 'domain' });
  const product = transition('ds_orders', sara, 'certify', { visibility: 'shared' });
  assert.equal(product.tier, 'product');
  // Now a finance user sees it in the marketplace group.
  assert.equal(listDatasets(kenji).marketplace.some((x) => x.id === 'ds_orders'), true);
});

test('promoted asset is visible to domain peers, denied cross-domain without a grant', () => {
  transition('ds_orders', sara, 'promote', { visibility: 'domain' });
  const beaSees = listDatasets(bea).domain.some((x) => x.id === 'ds_orders'); // sales peer
  assert.equal(beaSees, true);
  assert.throws(() => getDataset('ds_orders', kenji), (e: DatasetError) => e.status === 403); // finance, no grant
});

test('a named cross-domain individual grant lets that user view the asset', () => {
  transition('ds_orders', sara, 'promote', {
    visibility: 'domain',
    grants: [{ grantee: { kind: 'user', id: 'kenji' }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }],
  });
  assert.doesNotThrow(() => getDataset('ds_orders', kenji));
});

test('define a metric requires a built Gold version on a GOVERNED asset/product', () => {
  // (1) no Gold yet → blocked on Gold
  assert.throws(
    () => defineMeasure('ds_orders', amir, { name: 'revenue', type: 'sum', sql: 'net_amount' }),
    /Gold/,
  );
  buildVersion('ds_orders', amir, 'gold', { quality: 'passing', artifact: 'gold/mart_orders.sql' });
  // (2) Gold built but still a private dataset → blocked (Cube reads the Trino mart)
  assert.throws(
    () => defineMeasure('ds_orders', amir, { name: 'revenue', type: 'sum', sql: 'net_amount' }),
    /governed/i,
  );
  // (3) promote to a governed asset → the metric is allowed; artifacts regenerate
  transition('ds_orders', sara, 'promote', { visibility: 'domain' });
  const d = defineMeasure('ds_orders', sara, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  assert.equal(d.measures[0].name, 'revenue');
});

test('files: dataset.yaml is editable, native artifacts are Build-materialised', () => {
  const { files } = listFiles('ds_orders', amir);
  assert.ok(files.includes('dataset.yaml'));
  assert.ok(files.includes('silver/stg_orders.sql'));
  // hand-editing a native file is refused (Build owns it)
  assert.throws(
    () => writeFile('ds_orders', amir, { path: 'silver/stg_orders.sql', content: 'x', sha: '' }),
    (e: DatasetError) => e.status === 403,
  );
});

test('unshare drops grants and returns the asset to a private dataset', () => {
  transition('ds_orders', sara, 'promote', { visibility: 'domain' });
  const back = transition('ds_orders', sara, 'unshare');
  assert.equal(back.tier, 'dataset');
  assert.equal(back.visibility, 'private');
  assert.equal(back.grants.length, 0);
});
