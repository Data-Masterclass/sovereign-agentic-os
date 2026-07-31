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
  archiveDataset,
  unarchiveDataset,
  isDatasetArchived,
  deleteDataset,
  moveDataset,
  setDocs,
  setDatasetSync,
  renameDataset,
  listDatasetVersions,
  restoreDatasetVersion,
  assetTarget,
  type Principal,
} from './store.ts';
import { versionTarget } from './store-fqn.ts';
import { DatasetError } from './dataset-schema.ts';
import { cubeName, cubeViewName, CUBE_ARTIFACT } from './metrics.ts';
import { listFolders as folderList, __resetStore as resetFolders } from '../folders/index.ts';

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

test('SECURITY: listJoinable is ACTIVE-DOMAIN scoped — owner and certified-product bypasses never leak across domains', () => {
  // Regression for the live leak (2026-07-31): an admin operating agentic-leader saw
  // Kiekert datasets in the Gold JOIN TO dropdown. canView passes via the OWNER check
  // (their own other-domain assets) and via tier 'product' (canView-true tenant-wide);
  // the picker must ALSO narrow to the active domain, like the main list.
  const boss: Principal = { id: 'boss', domains: ['sales', 'finance'], role: 'admin' };
  const bossInSales: Principal = { id: 'boss', domains: ['sales'], role: 'admin' }; // operating sales
  const bossInFinance: Principal = { id: 'boss', domains: ['finance'], role: 'admin' };

  // A promoted FINANCE asset owned by boss (owner bypass)…
  const finAsset = createDataset(boss, { name: 'Kiekert Cases', domain: 'finance' });
  buildVersion(finAsset.id, boss, 'bronze', { quality: 'passing', artifact: 'bronze/k.dlt.yml' });
  buildVersion(finAsset.id, boss, 'silver', { quality: 'passing', artifact: 'silver/k.sql' });
  transition(finAsset.id, boss, 'promote', { visibility: 'domain' }); // → asset (finance)
  // …and a CERTIFIED finance product (product bypass: canView-true for everyone).
  const finProduct = createDataset(boss, { name: 'Kiekert Certified', domain: 'finance' });
  buildVersion(finProduct.id, boss, 'bronze', { quality: 'passing', artifact: 'bronze/kc.dlt.yml' });
  buildVersion(finProduct.id, boss, 'silver', { quality: 'passing', artifact: 'silver/kc.sql' });
  transition(finProduct.id, boss, 'promote', { visibility: 'domain' });
  transition(finProduct.id, boss, 'certify', { visibility: 'shared' }); // → product (finance)

  // Operating SALES: neither finance dataset may appear — not for the owner-admin,
  // not for an unrelated sales user (Marketplace is the only cross-domain surface).
  for (const u of [bossInSales, bea]) {
    const names = listJoinable(u).map((d) => d.name);
    assert.ok(!names.includes('Kiekert Cases'), `owner-bypass leak for ${u.id}: ${names}`);
    assert.ok(!names.includes('Kiekert Certified'), `product-bypass leak for ${u.id}: ${names}`);
  }
  // Operating FINANCE (positive control): both are offered.
  const inFinance = listJoinable(bossInFinance).map((d) => d.name);
  assert.ok(inFinance.includes('Kiekert Cases') && inFinance.includes('Kiekert Certified'), `expected both in finance, got: ${inFinance}`);
  // "All domains" session (domains includes finance) also sees them.
  assert.ok(listJoinable(boss).some((d) => d.name === 'Kiekert Certified'));
});

test('buildGoldJoin with NO measures preserves the Publish-defined ones (never wipes)', () => {
  // Measures live in the Publish stage now — the Gold panel always sends an empty
  // list, and a gold REBUILD must not clear what defineMeasure already declared.
  const orders = seedOrders();
  const goldInput = {
    measures: [],
    upstreams: [],
    artifact: 'gold/mart_orders.sql',
    body: 'create or replace table iceberg.personal_amir.gold_orders as select 1 as x',
  };
  buildGoldJoin(orders, amir, goldInput); // first build (row-level, no measures)
  transition(orders, sara, 'promote', { visibility: 'domain' }); // metrics need a governed Gold
  defineMeasure(orders, sara, { name: 'order_count', type: 'count', sql: '' }); // Publish stage
  const rebuilt = buildGoldJoin(orders, amir, goldInput); // rebuild from the Gold panel
  assert.equal(rebuilt.versions.gold.built, true);
  assert.deepEqual(rebuilt.measures.map((m) => m.name), ['order_count']);
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

test('buildGoldJoin persists the raw goldSpec so the panel RE-HYDRATES joins/dims/measures', () => {
  const orders = seedOrders();
  const goldSpec = {
    joins: [{ datasetId: 'ds_np', type: 'inner' as const, baseCol: 'order_id', joinCol: 'order_id' }],
    dimensions: [{ source: '1::region' }, { source: '0::order_id', as: 'oid' }],
    measures: [{ name: 'net', agg: 'sum', col: '1::net_amount' }, { name: 'n', agg: 'count' }],
  };
  buildGoldJoin(orders, amir, {
    measures: [{ name: 'net', type: 'sum', sql: 'net' }],
    upstreams: [{ datasetId: 'ds_np', name: 'Northpeak Commerce', fqn: 'iceberg.sales.gold_northpeak_commerce', joinType: 'inner' }],
    artifact: 'gold/mart_orders.sql',
    body: 'create or replace table iceberg.personal_amir.gold_orders as select 1 as x',
    goldSpec,
  });
  // Round-trips through serialize/parse (the durable single source) exactly.
  const reopened = getDataset(orders, amir);
  assert.deepEqual(reopened.goldSpec, goldSpec);
  assert.equal(reopened.goldSpec?.joins[0].datasetId, 'ds_np');
  assert.equal(reopened.goldSpec?.joins[0].baseCol, 'order_id');
  assert.deepEqual(reopened.goldSpec?.dimensions.map((d) => d.source), ['1::region', '0::order_id']);
  assert.deepEqual(reopened.goldSpec?.measures.map((m) => m.name), ['net', 'n']);
});

test('a Gold build WITHOUT a goldSpec leaves the field absent (byte-stable, no churn)', () => {
  const orders = seedOrders();
  buildGoldJoin(orders, amir, {
    measures: [], upstreams: [], artifact: 'gold/mart_orders.sql',
    body: 'create or replace table iceberg.personal_amir.gold_orders as select 1 as x',
  });
  assert.equal(getDataset(orders, amir).goldSpec, undefined);
});

test('buildGoldJoin lights Gold for a single-table build (no join partner, empty upstreams)', () => {
  const orders = seedOrders();
  const updated = buildGoldJoin(orders, amir, {
    measures: [{ name: 'orders', type: 'sum', sql: 'orders' }],
    upstreams: [], // single-table Gold — no dataset was joined
    artifact: 'gold/mart_orders.sql',
    body: 'create or replace table iceberg.personal_amir.gold_orders as select count(*) as orders from iceberg.personal_amir.silver_orders t0',
  });
  assert.equal(updated.versions.gold.built, true);
  assert.equal(updated.upstreams?.length, 0);
  assert.deepEqual(updated.measures.map((m) => m.name), ['orders']);
  const reopened = getDataset(orders, amir);
  assert.equal(reopened.versions.gold.built, true);
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

test('only Admin certifies asset -> product; the per-tab Company tier is domain-isolated', () => {
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' });
  const product = transition(id, sara, 'certify', { visibility: 'shared' });
  assert.equal(product.tier, 'product');
  // Strict isolation: the sales-homed product shows in a SALES user's Company tier…
  assert.equal(listDatasets(sara).marketplace.some((x) => x.id === id), true);
  // …but NOT in a finance user's per-tab list. Cross-domain discovery is the dedicated
  // Marketplace catalog's job; a finance domain adopts it via importProduct.
  assert.equal(listDatasets(kenji).marketplace.some((x) => x.id === id), false);
});

test('own promoted (Shared) dataset groups under Domain, not Mine', () => {
  const id = seedOrders(); // owned by amir, private
  transition(id, sara, 'promote', { visibility: 'domain' }); // → shared asset
  const groups = listDatasets(amir); // the OWNER lists
  assert.ok(groups.domain.some((d) => d.id === id), 'own Shared dataset belongs under Domain');
  assert.ok(!groups.mine.some((d) => d.id === id), 'own Shared dataset is NOT under Mine');
});

test('own certified (Marketplace) dataset groups under Marketplace, not Mine', () => {
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' });
  transition(id, sara, 'certify', { visibility: 'shared' }); // → marketplace product
  const groups = listDatasets(amir); // the OWNER lists
  assert.ok(groups.marketplace.some((d) => d.id === id), 'own product belongs under Marketplace');
  assert.ok(!groups.mine.some((d) => d.id === id), 'own product is NOT under Mine');
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

test('define a metric requires only a built Gold (any tier) — metrics→Trino migration Phase 1', () => {
  const id = seedOrders();
  // (1) no Gold yet → still blocked on Gold (the metric serves SQL over the gold mart)
  assert.throws(
    () => defineMeasure(id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' }),
    /Gold/,
  );
  buildVersion(id, amir, 'gold', { quality: 'passing', artifact: 'gold/mart_orders.sql' });
  // (2) Gold built on a PERSONAL dataset → now ALLOWED (served as governed Trino SQL over the
  // owner's personal lane). The portable MetricFlow semantic declaration is emitted; the CUBE
  // artifacts are NOT (a broken cube must never be registered on personal gold — #91 preserved).
  const personal = defineMeasure(id, amir, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  assert.equal(personal.measures[0].name, 'revenue');
  const personalFiles = listFiles(id, amir).files;
  assert.ok(personalFiles.some((f) => f.startsWith('semantic/')), 'semantic declaration emitted on personal gold');
  assert.ok(!personalFiles.some((f) => f.endsWith('.cube.yml')), 'no cube artifact on personal gold');
  // (3) promote to a governed asset → the cube artifacts now regenerate too.
  transition(id, sara, 'promote', { visibility: 'domain' });
  defineMeasure(id, sara, { name: 'order_count', type: 'count', sql: '' });
  const governedFiles = listFiles(id, sara).files;
  assert.ok(governedFiles.some((f) => f.endsWith('.cube.yml')), 'cube artifact regenerates once governed');
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
  // Index-AWARE: keyed by `${index}\n${id}` so the datasets index and the
  // `os-versions-dataset` snapshot index (which the version log mirrors to) stay
  // isolated — the same discipline real OpenSearch enforces. `datasetDocs()` counts
  // only the datasets index, so version snapshots never inflate the dataset count.
  const docs = new Map<string, unknown>();
  const orig = globalThis.fetch;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  // The index segment lives between the host and the `/_doc|_search|_count` op.
  const indexOf = (u: string) => (u.split('/').find((seg) => seg.startsWith('os-')) ?? '');
  const inIndex = (idx: string) =>
    [...docs.entries()].filter(([k]) => k.startsWith(`${idx}\n`)).map(([, v]) => v);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    const method = init?.method ?? 'GET';
    const idx = indexOf(u);
    if (u.endsWith('/_count')) return json({ count: inIndex(idx).length });
    if (method === 'HEAD') return new Response(null, { status: 200 });
    if (u.includes('/_search')) {
      return json({ hits: { hits: inIndex(idx).map((_source) => ({ _source })) } });
    }
    if (u.includes('/_doc/')) {
      const id = decodeURIComponent(u.split('/_doc/')[1].split('?')[0]);
      const key = `${idx}\n${id}`;
      if (method === 'DELETE') docs.delete(key);
      else docs.set(key, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'ok' });
    }
    return json({});
  }) as typeof fetch;
  const datasetDocs = () => inIndex('os-datasets');
  return { docs, datasetDocs, restore: () => { globalThis.fetch = orig; } };
}

test('the data store mirrors writes to the backend and hydrates from it after a restart', async () => {
  const os = fakeOpenSearch();
  try {
    await ensureHydrated();
    const id = seedOrders(); // create + build → mirrored fire-and-forget
    // Fire-and-forget writes settle on the next tick.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(os.datasetDocs().length, 1, 'the write was mirrored to the durable backend');

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

// ------------------------------------------------ archive / delete -----------

test('archive hides a dataset from the working lists; unarchive restores it', () => {
  __resetStore();
  const d = createDataset(amir, { name: 'Scratch' });
  assert.equal(listDatasets(amir).mine.length, 1);

  const s = archiveDataset(d.id, amir);
  assert.equal(s.archived, true);
  // Hidden by default…
  assert.equal(listDatasets(amir).mine.length, 0);
  // …but visible (and flagged) with includeArchived.
  const withArchived = listDatasets(amir, { includeArchived: true });
  assert.equal(withArchived.mine.length, 1);
  assert.equal(withArchived.mine[0].archived, true);

  const back = unarchiveDataset(d.id, amir);
  assert.equal(back.archived, false);
  assert.equal(listDatasets(amir).mine.length, 1);
  assert.equal(listDatasets(amir).mine[0].archived, false);
});

test('isDatasetArchived exposes the record-level flag (view-scoped) so the detail can offer Restore', () => {
  __resetStore();
  const d = createDataset(amir, { name: 'Scratch' });
  assert.equal(isDatasetArchived(d.id, amir), false);
  archiveDataset(d.id, amir);
  assert.equal(isDatasetArchived(d.id, amir), true, 'archived flag is visible to the owner');
  unarchiveDataset(d.id, amir);
  assert.equal(isDatasetArchived(d.id, amir), false, 'restore clears the flag');
});

test('SECURITY: archive/unarchive/delete are edit-scoped (a non-owner viewer is 403)', () => {
  __resetStore();
  // A promoted sales asset amir authored — kenji (finance) cannot even see it,
  // and bea (sales creator, not owner/admin) can see but not manage it.
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' }); // → asset (sales)
  assert.throws(() => archiveDataset(id, bea), (e: DatasetError) => e.status === 403);
  assert.throws(() => deleteDataset(id, kenji), (e: DatasetError) => e.status === 403);
  // The owner may; an in-domain admin may too.
  assert.equal(archiveDataset(id, amir).archived, true);
  assert.equal(unarchiveDataset(id, sara).archived, false);
});

test('FOLDER: moveDataset is edit-scoped, normalises, and reflects in the summary', () => {
  __resetStore();
  const id = seedOrders(); // amir-owned private dataset (personal lane)
  // The owner may move it; the path is normalised.
  const moved = moveDataset(id, amir, 'contracts/');
  assert.equal(moved.folder, '/contracts');
  // The tile summary carries the new folder for the rail/grid filter.
  assert.equal(listDatasets(amir).mine[0].folder, '/contracts');
  // A non-owner, non-admin in the same domain cannot move it (fail-closed 403).
  assert.throws(() => moveDataset(id, bea, '/elsewhere'), (e: DatasetError) => e.status === 403);
  // NEW manage-rights rule: a PRIVATE (personal) dataset is owner-only — not even a
  // platform admin may move (manage) another user's private data.
  assert.throws(() => moveDataset(id, sara, '/legal'), (e: DatasetError) => e.status === 403);
  // Moving back to root serializes without a folder key (byte-stable) — folder is '/'.
  assert.equal(moveDataset(id, amir, '/').folder, '/');
});

test('FOLDER: moving into a folder upserts an explicit registry row (persists when empty)', () => {
  __resetStore();
  resetFolders();
  const id = seedOrders();
  moveDataset(id, amir, '/contracts');
  // The governed folder registry now holds a `tab:'data'` personal row for the path.
  const rows = folderList(amir, 'data', 'personal');
  assert.ok(rows.some((r) => r.path === '/contracts'), 'move must upsert the folder row');
});

test('LIFECYCLE: archive THEN delete — the owner purges an archived dataset; a non-owner non-admin is 403', () => {
  __resetStore();
  // The streamlined Data-tab lifecycle: archive first (reversible), then a physical
  // delete of the ARCHIVED artifact. Delete must not require live state, and must
  // authorize via the SAME edit-scope rule as everywhere else.
  const id = seedOrders(); // amir-owned, bronze+silver built
  archiveDataset(id, amir);
  assert.equal(listDatasets(amir, { includeArchived: true }).mine[0].archived, true);
  // A non-owner, non-admin in the same domain cannot delete the archived dataset.
  assert.throws(() => deleteDataset(id, bea), (e: DatasetError) => e.status === 403);
  // The owner can — even while archived — and it purges the record for good.
  const deleted = deleteDataset(id, amir);
  assert.equal(deleted.id, id);
  assert.equal(listDatasets(amir, { includeArchived: true }).mine.length, 0);
  assert.throws(() => getDataset(id, amir), (e: DatasetError) => e.status === 404);
});

test('delete permanently removes a dataset; a missing dataset is 404', () => {
  __resetStore();
  const d = createDataset(amir, { name: 'Ephemeral' });
  deleteDataset(d.id, amir);
  assert.equal(listDatasets(amir, { includeArchived: true }).mine.length, 0);
  assert.throws(() => getDataset(d.id, amir), (e: DatasetError) => e.status === 404);
  assert.throws(() => deleteDataset(d.id, amir), (e: DatasetError) => e.status === 404);
});

test('delete is refused while other domains import the product (no orphaned dependency)', () => {
  __resetStore();
  const id = seedOrders();
  transition(id, sara, 'promote', { visibility: 'domain' });
  transition(id, sara, 'certify', { visibility: 'shared' }); // → product (sales)
  importProduct(id, finBuilder); // finance subscribes
  assert.throws(() => deleteDataset(id, sara), (e: DatasetError) => e.status === 409);
  // Archive stays available even for a governed product (reversible hide).
  assert.equal(archiveDataset(id, sara).archived, true);
});

// ---------------------------------------------------------- version history --

test('VERSIONS: each edit snapshots the PRIOR dataset.yaml, newest first', () => {
  const d = createDataset(amir, { name: 'Orders' });
  // A fresh dataset has no history yet — the first edit starts it.
  assert.equal(listDatasetVersions(d.id, amir).length, 0);
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  setDocs(d.id, amir, { description: 'first' });
  setDocs(d.id, amir, { description: 'second' });
  const hist = listDatasetVersions(d.id, amir);
  // 3 edits after creation → 3 snapshots of the superseded states, newest first.
  assert.equal(hist.length, 3);
  assert.equal(hist[0].summary, 'edit docs');
  assert.equal(hist[0].author, 'amir');
  assert.deepEqual(hist.map((v) => v.version), [3, 2, 1]);
});

test('VERSIONS: restore reverts the definition and is itself an undoable version', () => {
  const d = createDataset(amir, { name: 'Orders' });
  setDocs(d.id, amir, { description: 'v1 description' });
  setDocs(d.id, amir, { description: 'v2 description' });
  assert.equal(getDataset(d.id, amir).description, 'v2 description');
  // Version 2 snapshotted the state right before the 2nd edit → description 'v1'.
  const before = listDatasetVersions(d.id, amir).length;
  const restored = restoreDatasetVersion(d.id, amir, 2);
  assert.equal(restored.description, 'v1 description');
  assert.equal(getDataset(d.id, amir).description, 'v1 description');
  // Restore snapshotted the live state first, so history GREW (reversible).
  assert.equal(listDatasetVersions(d.id, amir).length, before + 1);
  assert.match(listDatasetVersions(d.id, amir)[0].summary, /restore of v2/);
});

test('VERSIONS: history is view-scoped; a non-viewer is refused', () => {
  const d = createDataset(amir, { name: 'Orders' });
  setDocs(d.id, amir, { description: 'private' });
  // kenji (finance) cannot see amir's private dataset → cannot read its history.
  assert.throws(() => listDatasetVersions(d.id, kenji), (e: DatasetError) => e.status === 403);
  // And a creator cannot restore a dataset they cannot edit.
  assert.throws(() => restoreDatasetVersion(d.id, kenji, 1), (e: DatasetError) => e.status === 403);
});

test('VERSIONS: a missing version number is refused (404)', () => {
  const d = createDataset(amir, { name: 'Orders' });
  setDocs(d.id, amir, { description: 'x' });
  assert.throws(() => restoreDatasetVersion(d.id, amir, 99), (e: DatasetError) => e.status === 404);
});

// ------------------------------------------------------ #155 domain-namespaced cube ---

test('#155 same dataset name is still BLOCKED within a domain (409)', () => {
  createDataset(amir, { name: 'Sales' }); // sales domain
  assert.throws(
    () => createDataset(bea, { name: 'Sales' }), // also sales — collides
    (e: DatasetError) => e.status === 409,
  );
});

test('#155 the SAME name is now ALLOWED across domains, with DISTINCT cube identities', () => {
  const salesDs = createDataset(amir, { name: 'Sales' }); // sales
  const finDs = createDataset(kenji, { name: 'Sales' }); // finance — no longer collides
  // Both created (no throw), and each carries the namespaced cube identity marker.
  assert.equal(salesDs.cubeNamespaced, true);
  assert.equal(finDs.cubeNamespaced, true);
  // Their cube name / view / model file are all distinct — no shared cube/view/file.
  assert.notEqual(cubeName(salesDs), cubeName(finDs));
  assert.notEqual(cubeViewName(salesDs), cubeViewName(finDs));
  assert.notEqual(CUBE_ARTIFACT(salesDs), CUBE_ARTIFACT(finDs));
  assert.equal(cubeName(salesDs), 'sales__sales');
  assert.equal(cubeName(finDs), 'finance__sales');
});

// ------------------------------------------------- rename: display name + FROZEN slug --

test('renameDataset: FQN STABILITY — a rename never moves the physical table', () => {
  // Create "Foo", build through gold in amir's personal lane.
  const d = createDataset(amir, { name: 'Foo' });
  buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/foo.dlt.yml' });
  buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_foo.sql' });
  buildVersion(d.id, amir, 'gold', { quality: 'passing', artifact: 'gold/mart_foo.sql' });

  const before = getDataset(d.id, amir);
  const ownerFqnBefore = versionTarget(before, 'gold', { id: amir.id });
  assert.equal(ownerFqnBefore, 'iceberg.personal_amir.gold_foo');
  assert.equal(cubeName(before), 'sales__foo'); // new datasets are namespaced (#155)

  // Rename Foo → Bar.
  const renamed = renameDataset(d.id, amir, 'Bar');
  assert.equal(renamed.name, 'Bar');           // display name changed
  assert.equal(renamed.slug, 'foo');           // slug FROZEN to the original physical table

  const after = getDataset(d.id, amir);
  // Every physical identity STILL uses slug("Foo") === "foo", NEVER slug("Bar") === "bar".
  assert.equal(versionTarget(after, 'gold', { id: amir.id }), 'iceberg.personal_amir.gold_foo');
  assert.equal(versionTarget(after, 'bronze', { id: amir.id }), 'iceberg.personal_amir.bronze_foo');
  assert.equal(cubeName(after), 'sales__foo', 'cube identity is frozen across a rename');
  assert.doesNotMatch(versionTarget(after, 'gold', { id: amir.id }), /_bar/, 'no live table orphaned');
});

test('renameDataset: an existing (never-renamed) dataset resolves to slug(name), unchanged', () => {
  const d = createDataset(amir, { name: 'Orders' });
  const before = getDataset(d.id, amir);
  assert.equal(before.slug, undefined, 'no slug field until a rename decouples it');
  assert.equal(cubeName(before), 'sales__orders'); // derived from slug("Orders")
});

test('renameDataset: owner allowed; a shared dataset admits domain_admin/admin; a non-owner non-admin denied', () => {
  // amir owns a Personal dataset — owner may rename, but nobody else (private is owner-only).
  const personal = createDataset(amir, { name: 'Private Foo' });
  assert.equal(renameDataset(personal.id, amir, 'Private Bar').name, 'Private Bar');
  // A domain builder is NOT an owner and cannot manage a PRIVATE dataset.
  assert.throws(() => renameDataset(personal.id, bea, 'Hijack'), (e) => (e as DatasetError).status === 403);

  // Promote to a shared asset so canManageArtifact admits an in-domain domain_admin.
  buildVersion(personal.id, amir, 'bronze', { quality: 'passing', artifact: 'b.dlt.yml' });
  buildVersion(personal.id, amir, 'silver', { quality: 'passing', artifact: 's.sql' });
  setDocs(personal.id, amir, { description: 'docs', columns: [{ name: 'id', description: 'k' }] });
  transition(personal.id, sara, 'promote'); // Admin promotes to a shared asset
  const domainAdmin: Principal = { id: 'dadmin', domains: ['sales'], role: 'domain_admin' };
  // A shared asset: an in-domain domain_admin may rename it.
  assert.equal(renameDataset(personal.id, domainAdmin, 'Shared Renamed').name, 'Shared Renamed');
  // A bare creator who is not the owner still may not.
  const stranger: Principal = { id: 'nobody', domains: ['sales'], role: 'creator' };
  assert.throws(() => renameDataset(personal.id, stranger, 'Nope'), (e) => (e as DatasetError).status === 403);
});

test('renameDataset: rejects an empty name and a within-domain duplicate', () => {
  const a = createDataset(amir, { name: 'Alpha' });
  createDataset(amir, { name: 'Beta' });
  assert.throws(() => renameDataset(a.id, amir, '   '), (e) => (e as DatasetError).status === 400);
  assert.throws(() => renameDataset(a.id, amir, 'Beta'), (e) => (e as DatasetError).status === 409);
});

// ------------------------------------------------------- scheduled sync setter --

test('setDatasetSync validates, persists, and clears; edit-gated', async () => {
  await ensureHydrated();
  const id = createDataset(amir, { name: 'Synced orders' }).id;
  const sync = {
    connectionId: 'conn_pg',
    source: { schema: 'public', table: 'orders' },
    mode: 'append' as const,
    cursor: { kind: 'timestamp' as const, column: 'updated_at' },
    schedule: { cron: '0 6 * * *' },
    enabled: true,
  };
  const d = setDatasetSync(id, amir, sync);
  assert.deepEqual(d.sync, sync);
  assert.deepEqual(getDataset(id, amir).sync, sync);

  // Invalid configs are strict 400s.
  assert.throws(() => setDatasetSync(id, amir, { ...sync, schedule: { cron: 'bad' } }), /cron/);
  assert.throws(() => setDatasetSync(id, amir, { ...sync, cursor: undefined }), /cursor/);
  assert.throws(
    () => setDatasetSync(id, amir, { ...sync, mode: 'merge' as const }),
    /merge key/,
  );
  assert.throws(
    () => setDatasetSync(id, amir, { ...sync, cursor: { kind: 'delta-version' as const, column: 'v' } }),
    /not implemented/,
  );

  // A non-owner peer cannot touch a private dataset's sync.
  assert.throws(() => setDatasetSync(id, kenji, null), DatasetError);

  // Clearing removes the block.
  assert.equal(setDatasetSync(id, amir, null).sync, undefined);
});
