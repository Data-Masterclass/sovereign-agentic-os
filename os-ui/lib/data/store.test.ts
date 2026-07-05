/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  ensureHydrated,
  listDatasets,
  getDataset,
  createDataset,
  buildVersion,
  defineMeasure,
  transition,
  importProduct,
  listFiles,
  writeFile,
  listJoinable,
  buildGoldJoin,
  type Principal,
} from './store.ts';
import { DatasetError } from './dataset-schema.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' }; // Creator
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'builder' };
const sara: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };
const finBuilder: Principal = { id: 'fatima', domains: ['finance'], role: 'builder' };

beforeEach(() => __resetStore());

/**
 * The store ships EMPTY now (no baked-in demo). Tests that exercise the
 * worked-example governance flow build an "Orders" dataset (private, owned by
 * amir, bronze+silver materialised) through the public API and use its id.
 */
function seedOrders(): string {
  const d = createDataset(amir, { name: 'Orders' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  return d.id;
}

test('SECURITY: a participant/creator cannot import a cross-domain data product', () => {
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' });
  transition(id, sara, 'certify', { visibility: 'shared' }); // → tier 'product' (sales)
  // kenji (finance, participant) may not self-import — it grants his whole domain.
  assert.throws(() => importProduct(id, kenji), (e: DatasetError) => e.status === 403);
  // A finance Builder may.
  const product = importProduct(id, finBuilder);
  assert.ok(product.imports?.includes('finance'));
});

test('GOVERNANCE: the Gold join picker (listJoinable) is canView-scoped', () => {
  // A promoted sales asset, plus a private finance dataset the sales users can't see.
  const orders = seedOrders();
  transition(orders, sara, 'promote', { visibility: 'domain' }); // → asset (sales, silver built)
  const secret = createDataset(kenji, { name: 'Finance Ledger' }).id;
  buildVersion(secret, kenji, 'bronze', { quality: 'passing', artifact: 'bronze/l.dlt.yml' });
  buildVersion(secret, kenji, 'silver', { quality: 'passing', artifact: 'silver/l.sql' });

  // A sales builder can reuse the promoted sales asset…
  const forBea = listJoinable(bea);
  assert.deepEqual(forBea.map((d) => d.name), ['Orders']);
  assert.equal(forBea[0].fqn, 'iceberg.sales.silver_orders'); // physical FQN, not gold (gold unbuilt)

  // …but NEVER the private finance dataset (canView false) — for anyone outside it.
  assert.ok(!listJoinable(bea).some((d) => d.name === 'Finance Ledger'));
  assert.ok(!listJoinable(amir).some((d) => d.name === 'Finance Ledger'));
  // kenji sees his own only if it were shared; a private dataset is never joinable even
  // for its owner (reuse is a governed-tier concept), and it never leaks cross-domain.
  assert.ok(!listJoinable(finBuilder).some((d) => d.name === 'Orders')); // sales asset, not finance-visible

  // The base dataset is excluded from its own picker.
  assert.ok(!listJoinable(bea, orders).some((d) => d.id === orders));
});

test('buildGoldJoin lights Gold + records measures and multi-upstream lineage', () => {
  const orders = seedOrders();
  const updated = buildGoldJoin(orders, amir, {
    measures: [{ name: 'net_after_returns', type: 'sum', sql: 'net_after_returns' }],
    upstreams: [{ datasetId: 'ds_np', name: 'Northpeak Commerce', fqn: 'iceberg.sales.gold_northpeak_commerce', joinType: 'inner' }],
    artifact: 'gold/mart_orders.sql',
    body: 'create or replace table iceberg.personal_amir.gold_orders as select 1 as x',
  });
  assert.equal(updated.versions.gold.built, true);
  assert.deepEqual(updated.measures.map((m) => m.name), ['net_after_returns']);
  assert.equal(updated.upstreams?.length, 1);
  assert.equal(updated.upstreams?.[0].fqn, 'iceberg.sales.gold_northpeak_commerce');
  // survives a serialize/parse round-trip (the durable single source).
  const reopened = getDataset(orders, amir);
  assert.equal(reopened.upstreams?.[0].name, 'Northpeak Commerce');
});

test('a fresh tenant has no datasets', () => {
  assert.equal(listDatasets(amir).mine.length, 0);
  assert.equal(listDatasets(amir).domain.length, 0);
  assert.equal(listDatasets(amir).marketplace.length, 0);
});

test('the built Orders example is a private dataset for amir', () => {
  const id = seedOrders();
  const groups = listDatasets(amir);
  assert.equal(groups.mine.length, 1);
  assert.equal(groups.mine[0].name, 'Orders');
  assert.equal(groups.mine[0].id, id);
  assert.deepEqual(groups.mine[0].dots, { bronze: true, silver: true, gold: false });
});

test('private dataset is owner-only — another user cannot see or open it', () => {
  const id = seedOrders();
  assert.equal(listDatasets(kenji).mine.length, 0);
  assert.equal(listDatasets(kenji).domain.length, 0);
  assert.throws(() => getDataset(id, kenji), (e: DatasetError) => e.status === 403);
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
  const id = seedOrders();
  // amir (Creator) is blocked
  assert.throws(() => transition(id, amir, 'promote'), (e: DatasetError) => e.status === 403);
  // The realistic flow: an admin/owner promotes.
  const promoted = transition(id, sara, 'promote', { visibility: 'domain' });
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
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' });
  const product = transition(id, sara, 'certify', { visibility: 'shared' });
  assert.equal(product.tier, 'product');
  // Now a finance user sees it in the marketplace group.
  assert.equal(listDatasets(kenji).marketplace.some((x) => x.id === id), true);
});

test('promoted asset is visible to domain peers, denied cross-domain without a grant', () => {
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' });
  const beaSees = listDatasets(bea).domain.some((x) => x.id === id); // sales peer
  assert.equal(beaSees, true);
  assert.throws(() => getDataset(id, kenji), (e: DatasetError) => e.status === 403); // finance, no grant
});

test('a named cross-domain individual grant lets that user view the asset', () => {
  const id = seedOrders();
  transition(id, sara, 'promote', {
    visibility: 'domain',
    grants: [{ grantee: { kind: 'user', id: 'kenji' }, scope: { rows: [], columns: { mask: [], hide: [] } }, cardinality: 'low', action: 'read' }],
  });
  assert.doesNotThrow(() => getDataset(id, kenji));
});

test('define a metric requires a built Gold version on a GOVERNED asset/product', () => {
  const id = seedOrders();
  // (1) no Gold yet → blocked on Gold
  assert.throws(
    () => defineMeasure(id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' }),
    /Gold/,
  );
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'gold/mart_orders.sql' });
  // (2) Gold built but still a private dataset → blocked (Cube reads the Trino mart)
  assert.throws(
    () => defineMeasure(id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' }),
    /governed/i,
  );
  // (3) promote to a governed asset → the metric is allowed; artifacts regenerate
  transition(id, sara, 'promote', { visibility: 'domain' });
  const d = defineMeasure(id, sara, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  assert.equal(d.measures[0].name, 'revenue');
});

test('files: dataset.yaml is editable, native artifacts are Build-materialised', () => {
  const id = seedOrders();
  const { files } = listFiles(id, amir);
  assert.ok(files.includes('dataset.yaml'));
  assert.ok(files.includes('silver/stg_orders.sql'));
  // hand-editing a native file is refused (Build owns it)
  assert.throws(
    () => writeFile(id, amir, { path: 'silver/stg_orders.sql', content: 'x', sha: '' }),
    (e: DatasetError) => e.status === 403,
  );
});

test('unshare drops grants and returns the asset to a private dataset', () => {
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' });
  const back = transition(id, sara, 'unshare');
  assert.equal(back.tier, 'dataset');
  assert.equal(back.visibility, 'private');
  assert.equal(back.grants.length, 0);
});

// --------------------------------------------------------- durable mirror ----
// A minimal in-memory fake of the OpenSearch REST surface the store speaks to,
// installed over global.fetch. `docs` survives an in-process `__resetStore()`,
// so we can simulate an os-ui restart hydrating from the durable backend.
function fakeOpenSearch() {
  const docs = new Map<string, unknown>();
  const orig = globalThis.fetch;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    if (u.endsWith('/_count')) return json({ count: docs.size });
    if (method === 'HEAD') return new Response(null, { status: 200 });
    if (u.includes('/_search')) {
      return json({ hits: { hits: [...docs.values()].map((_source) => ({ _source })) } });
    }
    if (u.includes('/_doc/')) {
      const id = decodeURIComponent(u.split('/_doc/')[1].split('?')[0]);
      if (method === 'DELETE') docs.delete(id);
      else docs.set(id, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'ok' });
    }
    return json({});
  }) as typeof fetch;
  return { docs, restore: () => { globalThis.fetch = orig; } };
}

test('the data store mirrors writes to the backend and hydrates from it after a restart', async () => {
  const os = fakeOpenSearch();
  try {
    await ensureHydrated();
    const id = seedOrders(); // create + build → mirrored fire-and-forget
    // Fire-and-forget writes settle on the next tick.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(os.docs.size, 1, 'the write was mirrored to the durable backend');

    // Simulate an os-ui restart: wipe the in-process cache, keep the backend.
    __resetStore();
    assert.equal(listDatasets(amir).mine.length, 0, 'in-process cache is empty after restart');
    await ensureHydrated(); // rehydrate from the durable mirror
    const groups = listDatasets(amir);
    assert.equal(groups.mine.length, 1, 'the seeded dataset survived the restart');
    assert.equal(groups.mine[0].id, id);
  } finally {
    os.restore();
  }
});

test('cross-instance: writes are visible through globalThis symbol', () => {
  __resetStore();
  const d = createDataset(amir, { name: 'CrossInstance' });
  const raw = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.data.store')] as { store: Map<string, unknown> };
  assert.ok(raw && raw.store.has(d.id), 'record visible in globalThis state');
  assert.equal(listDatasets(amir).mine.length, 1);
});

test('the data store degrades gracefully when the backend is unavailable (never throws)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('backend down'); }) as typeof fetch;
  try {
    await ensureHydrated(); // must not throw
    const id = seedOrders(); // in-memory only
    assert.equal(listDatasets(amir).mine.length, 1, 'still works fully in-process');
    assert.equal(listDatasets(amir).mine[0].id, id);
  } finally {
    globalThis.fetch = orig;
  }
});
