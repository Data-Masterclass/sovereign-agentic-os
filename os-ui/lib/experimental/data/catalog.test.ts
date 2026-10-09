/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  listDatasets,
  createDataset,
  buildVersion,
  transition,
  type Principal,
} from './store.ts';
import {
  assembleCatalog,
  registryAssets,
  trinoStatus,
  type CatalogAsset,
} from './catalog.ts';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const bea: Principal = { id: 'bea', domains: ['sales'], role: 'admin' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };

beforeEach(() => __resetStore());

/** Build an Orders dataset (bronze+silver) so it is a real, materialisable record. */
function seedOrders(owner: Principal = amir): string {
  const d = createDataset(owner, { name: 'Orders' });
  buildVersion(d.id, owner, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  buildVersion(d.id, owner, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql' });
  return d.id;
}

const noTrino = async (): Promise<CatalogAsset[]> => [];
const noOm = async () => ({ assets: null, status: 'not configured — skipped' });

// --------------------------------------------------------------- union + labels --

test('assembleCatalog unions all three sources and labels every asset', async () => {
  const registry: CatalogAsset[] = [
    { name: 'Orders', fqn: 'iceberg.sales.silver_orders', description: '', type: 'dataset', source: 'registry' },
  ];
  const trino = async (): Promise<CatalogAsset[]> => [
    { name: 'gold_northpeak_commerce', fqn: 'iceberg.sales.gold_northpeak_commerce', description: '', type: 'iceberg table', source: 'trino' },
  ];
  const om = async () => ({
    assets: [{ name: 'dim_region', fqn: 'om.sales.dim_region', description: 'regions', type: 'table', source: 'openmetadata' as const }],
    status: 'OpenMetadata catalog',
  });

  const result = await assembleCatalog({ schema: 'sales', registry, trino, openmetadata: om });

  assert.equal(result.source, 'union');
  assert.equal(result.assets.length, 3);
  // Every source contributed and is labelled ok with its count.
  const byName = Object.fromEntries(result.sources.map((s) => [s.source, s]));
  assert.deepEqual([byName.registry.ok, byName.trino.ok, byName.openmetadata.ok], [true, true, true]);
  assert.deepEqual([byName.registry.count, byName.trino.count, byName.openmetadata.count], [1, 1, 1]);
  // Each asset carries an honest source label.
  assert.deepEqual(result.assets.map((a) => a.source).sort(), ['openmetadata', 'registry', 'trino']);
});

// -------------------------------------------------- never 500 on a missing schema --

test('assembleCatalog does NOT throw when the Trino schema is absent — honest status, registry preserved', async () => {
  const registry: CatalogAsset[] = [
    { name: 'Orders', fqn: 'iceberg.sales.silver_orders', description: '', type: 'dataset', source: 'registry' },
  ];
  const trinoMissing = async (): Promise<CatalogAsset[]> => {
    throw new Error("Trino query failed: line 1:1: Schema 'sales' does not exist");
  };

  const result = await assembleCatalog({ schema: 'sales', registry, trino: trinoMissing, openmetadata: noOm });

  // No throw; the registry asset still surfaces.
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].source, 'registry');
  const trino = result.sources.find((s) => s.source === 'trino')!;
  assert.equal(trino.ok, false);
  assert.match(trino.status, /not materialized yet/);
});

test('trinoStatus classifies a missing schema as not-materialized, other errors as unreachable', () => {
  assert.match(trinoStatus(new Error("Schema 'sales' does not exist"), 'sales'), /not materialized yet/);
  assert.match(trinoStatus(new Error('SCHEMA_NOT_FOUND'), 'x'), /not materialized yet/);
  assert.match(trinoStatus(new Error('Could not reach query-tool'), 'sales'), /warehouse unreachable/);
});

test('OpenMetadata without a bot token is skipped honestly, not a fallback', async () => {
  const result = await assembleCatalog({ schema: 'sales', registry: [], trino: noTrino, openmetadata: noOm });
  const om = result.sources.find((s) => s.source === 'openmetadata')!;
  assert.equal(om.ok, false);
  assert.equal(om.count, 0);
  assert.match(om.status, /skipped/);
});

test('an empty warehouse yields a valid empty catalog (registry-only), never an error', async () => {
  const result = await assembleCatalog({ schema: 'sales', registry: [], trino: noTrino, openmetadata: noOm });
  assert.equal(result.assets.length, 0);
  assert.equal(result.source, 'union');
  assert.equal(result.sources.length, 3); // all three reported, honestly
});

// ---------------------------------------- external OM connection discovery fold --

test('assembleCatalog folds in an external OM connection when one is present + reachable', async () => {
  const registry: CatalogAsset[] = [
    { name: 'Orders', fqn: 'iceberg.sales.silver_orders', description: '', type: 'dataset', source: 'registry' },
  ];
  const omConnection = async () => ({
    assets: [{ name: 'ext_orders', fqn: 'iceberg.sales.gold_ext', description: 'ext', type: 'table', source: 'om-connection' as const }],
    status: 'external catalog "Prod OM" · 1 discoverable table · 2 domains · 1 data product (DLS-scoped)',
    ok: true,
    count: 1,
    severity: 'ok' as const,
  });

  const result = await assembleCatalog({ schema: 'sales', registry, trino: noTrino, openmetadata: noOm, omConnection });

  const src = result.sources.find((s) => s.source === 'om-connection')!;
  assert.ok(src);
  assert.equal(src.ok, true);
  assert.equal(src.count, 1);
  assert.match(src.status, /DLS-scoped/);
  assert.ok(result.assets.some((a) => a.source === 'om-connection'));
});

test('assembleCatalog degrades honestly when the external OM is unreachable — no 500', async () => {
  const omConnection = async () => ({
    assets: null,
    status: 'reconnecting to external catalog "Prod OM"…',
    ok: false,
    count: 0,
    severity: 'warn' as const,
  });
  const result = await assembleCatalog({ schema: 'sales', registry: [], trino: noTrino, openmetadata: noOm, omConnection });
  const src = result.sources.find((s) => s.source === 'om-connection')!;
  assert.equal(src.ok, false);
  assert.equal(src.severity, 'warn');
  assert.match(src.status, /reconnecting/i);
});

test('assembleCatalog omits the om-connection source entirely when none is connected', async () => {
  const result = await assembleCatalog({ schema: 'sales', registry: [], trino: noTrino, openmetadata: noOm });
  assert.ok(!result.sources.some((s) => s.source === 'om-connection'));
  assert.equal(result.sources.length, 3); // registry + trino + openmetadata only
});

// ------------------------------------------------------------- DLS scoping holds --

test('registryAssets inherits DLS: a private dataset is invisible to other users', () => {
  seedOrders(amir); // private, owned by amir (domain sales)

  // Owner sees it in the catalog.
  const mine = registryAssets(listDatasets(amir));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].name, 'Orders');
  assert.match(mine[0].fqn, /^iceberg\.sales\.silver_orders$/);

  // A finance creator does NOT — the private dataset never reaches their catalog.
  const other = registryAssets(listDatasets(kenji));
  assert.equal(other.length, 0);
});

test('registryAssets shows a promoted domain asset to a domain peer only', () => {
  const id = seedOrders(amir);
  transition(id, bea, 'promote', { visibility: 'domain' }); // sara/bea admin promotes → tier asset (sales)

  // A sales domain peer now sees the shared asset in their catalog.
  const salesPeer: Principal = { id: 'nadia', domains: ['sales'], role: 'creator' };
  const peer = registryAssets(listDatasets(salesPeer));
  assert.equal(peer.length, 1);
  assert.equal(peer[0].type, 'data asset');

  // A finance user still does not (asset is domain-scoped, not a marketplace product).
  assert.equal(registryAssets(listDatasets(kenji)).length, 0);
});

test('an un-materialized registry dataset is catalogued but flagged not-materialized (no bad FQN)', () => {
  const d = createDataset(amir, { name: 'Draft Set' }); // nothing built
  void d;
  const assets = registryAssets(listDatasets(amir));
  assert.equal(assets.length, 1);
  assert.match(assets[0].fqn, /^registry:/); // not a physical iceberg FQN
  assert.match(assets[0].description, /not materialized yet/);
});
