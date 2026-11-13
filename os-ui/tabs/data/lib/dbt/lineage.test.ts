/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for lineage from the dbt manifest (engine rebuild B3, checklist D16)
 * USER STORY: As a reviewer I want proof that the graph shown comes from dbt's `ref()`/`source()`
 *             edges — including the warehouse table behind a sync — and that a dataset dbt has not
 *             seen yet falls back to the registry graph instead of rendering nothing.
 * ARCHITECTURE: Pure. A FIXTURE `manifest.json` is folded into the asset-graph node shape by
 *   `assetNodesFromManifest`, which is the equivalence dagster-dbt provides at runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { lineageFor } from '@tabs/data/lib/lineage';
import { graphLineage, assetNodesFromManifest, layerOfModel } from '@tabs/data/lib/dbt/lineage';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

function ds(input: Partial<Dataset> & { id: string; name: string; owner: string; domain: string }): Dataset {
  return {
    version: '1',
    tier: 'dataset',
    visibility: 'private',
    folder: '/',
    description: 'A documented dataset.',
    versions: emptyVersions(),
    grants: [],
    measures: [],
    columns: [{ name: 'customer_id', description: 'Customer key' }, { name: 'total_amount', description: 'Sum' }],
    viewNamespaced: true,
    ...input,
  };
}

const built = (artifact: string | null, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });

/** A fixture `manifest.json` shaped exactly as dbt writes it: a sync landing, a silver, a gold. */
const MANIFEST = {
  nodes: {
    'model.sales.silver_orders': { resource_type: 'model', name: 'silver_orders', description: 'Silver orders' },
    'model.sales.gold_order_customer': { resource_type: 'model', name: 'gold_order_customer', description: 'Orders joined to customers' },
    'model.sales.silver_customers': { resource_type: 'model', name: 'silver_customers', description: 'Customer master' },
    'test.sales.not_null_customer_id': { resource_type: 'test', name: 'not_null_customer_id' },
  },
  sources: {
    'source.sales.personal_amir.bronze_orders': { source_name: 'personal_amir', name: 'bronze_orders', description: 'Bronze landing' },
    'source.sales.wh__public.events': { source_name: 'wh__public', name: 'events', description: 'Warehouse events' },
  },
  parent_map: {
    'model.sales.silver_orders': ['source.sales.personal_amir.bronze_orders'],
    'model.sales.silver_customers': ['source.sales.wh__public.events'],
    'model.sales.gold_order_customer': ['model.sales.silver_orders', 'model.sales.silver_customers'],
    'test.sales.not_null_customer_id': ['model.sales.gold_order_customer'],
  },
};

function snapshot(datasets: Dataset[]): ProjectSnapshot {
  return { domain: 'sales', datasets: datasets.map((dataset) => ({ dataset, artifacts: {} })), catalogs: {} };
}

test('assetNodesFromManifest keys models and sources the way dagster-dbt does', () => {
  const nodes = assetNodesFromManifest(MANIFEST, 'sales');
  assert.deepEqual(nodes.map((n) => n.key), [
    ['sales', 'gold_order_customer'],
    ['sales', 'personal_amir', 'bronze_orders'],
    ['sales', 'silver_customers'],
    ['sales', 'silver_orders'],
    ['sales', 'wh__public', 'events'],
  ]);
  assert.deepEqual(
    nodes.find((n) => n.key[1] === 'gold_order_customer')!.dependsOn,
    [['sales', 'silver_orders'], ['sales', 'silver_customers']],
  );
  // A dbt TEST is not an asset node — it becomes an asset CHECK, which is a different read.
  assert.ok(!nodes.some((n) => n.key.includes('not_null_customer_id')));
  assert.deepEqual(assetNodesFromManifest({}, 'sales'), []);
  assert.deepEqual(assetNodesFromManifest(null, 'sales'), []);
});

test('the dataset graph is dbt\'s: refinement between its own layers, everything else upstream', () => {
  const orders = ds({
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    // Pass-through Silver (what an ingest produces): a MODEL. Gold is not built, so the dataset has
    // exactly one model in the project — and the manifest fixture carries exactly that one.
    versions: { bronze: built('bronze/orders.dlt.yml'), silver: built(null, true), gold: { built: false, passThrough: false, quality: 'unknown', updatedAt: null, artifact: null } },
  });
  // `silver_orders` + `gold_orders` are the models the planner names for this dataset; the manifest
  // fixture carries `silver_orders` only, so the graph has one version node and one upstream.
  const keys = datasetAssetKeys(snapshot([orders]), 'ds_orders1');
  const g = graphLineage(orders, assetNodesFromManifest(MANIFEST, 'sales'), keys)!;
  assert.equal(g.source, 'dbt');
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'version').map((n) => n.label), ['Silver']);
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'upstream').map((n) => n.sublabel), [
    'dbt source · sales.personal_amir.bronze_orders',
  ]);
  assert.deepEqual(g.edges, [{ from: 'up:sales/personal_amir/bronze_orders', to: 'v:silver', kind: 'join' }]);
  assert.equal(g.nodes.find((n) => n.kind === 'version')!.sublabel, 'models/…/silver_orders.sql');
  assert.deepEqual(g.nodes.find((n) => n.kind === 'version')!.columns, ['customer_id', 'total_amount']);
});

test('a composition shows both of its dbt parents and its measures', () => {
  const composition = ds({
    id: 'ds_oc000001',
    name: 'Order Customer',
    owner: 'amir',
    domain: 'sales',
    origin: 'curated',
    versions: { ...emptyVersions(), gold: built('gold/mart_order_customer.sql') },
    measures: [{ name: 'total_amount', type: 'sum', column: 'total_amount' }],
    upstreams: [
      { datasetId: 'ds_orders1', name: 'Orders', fqn: 'iceberg.personal_amir.silver_orders', joinType: 'inner' },
    ],
  });
  const snap: ProjectSnapshot = {
    domain: 'sales',
    datasets: [{ dataset: composition, artifacts: { 'gold/mart_order_customer.sql': 'create or replace table iceberg.personal_amir.gold_order_customer as select 1' }, compiled: ['gold/mart_order_customer.sql'] }],
    catalogs: {},
  };
  const keys = datasetAssetKeys(snap, 'ds_oc000001');
  const g = graphLineage(composition, assetNodesFromManifest(MANIFEST, 'sales'), keys)!;
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'upstream').map((n) => n.label).sort(), ['silver_customers', 'silver_orders']);
  assert.deepEqual(g.nodes.filter((n) => n.kind === 'metric').map((n) => n.label), ['total_amount']);
  assert.ok(g.edges.some((e) => e.from === 'v:gold' && e.kind === 'metric'));
  // Both parents are dbt MODELS, so their sublabel says model, not source.
  assert.ok(g.nodes.filter((n) => n.kind === 'upstream').every((n) => n.sublabel.startsWith('dbt model · ')));
});

test('a dataset dbt has not seen yet returns null, which is the caller\'s cue to fall back', () => {
  const fresh = ds({
    id: 'ds_new00001',
    name: 'Brand New',
    owner: 'amir',
    domain: 'sales',
    versions: { ...emptyVersions(), silver: built(null) },
  });
  const keys = datasetAssetKeys(snapshot([fresh]), 'ds_new00001');
  assert.equal(graphLineage(fresh, assetNodesFromManifest(MANIFEST, 'sales'), keys), null);
  // And the registry graph still answers, labelled as the registry.
  assert.equal(lineageFor(fresh).source, 'registry');
});

test('layerOfModel reads the OS naming and refuses to guess', () => {
  assert.equal(layerOfModel('silver_orders'), 'silver');
  assert.equal(layerOfModel('gold_order_customer'), 'gold');
  assert.equal(layerOfModel('bronze_x'), 'bronze');
  assert.equal(layerOfModel('stg_orders'), null);
  assert.equal(layerOfModel(''), null);
});

test('a PARTIALLY parsed project falls back, rather than labelling a truncated graph "dbt"', () => {
  // B3-review-M-1. Gold is in the asset graph but Silver is not (a half-parsed domain, or a commit
  // Dagster has only partly caught up with). The old code kept whatever it found and still set
  // `source: 'dbt'`, so the view said "dbt knows of no Silver here" — a wrong statement about
  // lineage, not a late one. All of the dataset's models, or none.
  const composition = ds({
    id: 'ds_oc000001',
    name: 'Order Customer',
    owner: 'amir',
    domain: 'sales',
    origin: 'curated',
    versions: { ...emptyVersions(), silver: built('silver/orders.sql'), gold: built('gold/mart_order_customer.sql') },
    upstreams: [{ datasetId: 'ds_orders1', name: 'Orders', fqn: 'iceberg.personal_amir.silver_orders', joinType: 'inner' }],
  });
  const snap: ProjectSnapshot = {
    domain: 'sales',
    datasets: [{
      dataset: composition,
      artifacts: {
        'silver/orders.sql': 'create or replace table iceberg.personal_amir.silver_orders as select 1',
        'gold/mart_order_customer.sql': 'create or replace table iceberg.personal_amir.gold_order_customer as select 1',
      },
      compiled: ['silver/orders.sql', 'gold/mart_order_customer.sql'],
    }],
    catalogs: {},
  };
  const keys = datasetAssetKeys(snap, 'ds_oc000001');
  assert.deepEqual(keys.models.map((m) => m.name), ['silver_order_customer', 'gold_order_customer']);

  // A manifest that carries BOTH of this dataset's models…
  const manifest = {
    nodes: {
      ...MANIFEST.nodes,
      'model.sales.silver_order_customer': { resource_type: 'model', name: 'silver_order_customer', description: 'Silver' },
    },
    sources: MANIFEST.sources,
    parent_map: {
      ...MANIFEST.parent_map,
      'model.sales.silver_order_customer': ['source.sales.personal_amir.bronze_orders'],
      'model.sales.gold_order_customer': ['model.sales.silver_order_customer'],
    },
  };
  const full = assetNodesFromManifest(manifest, 'sales');
  assert.ok(graphLineage(composition, full, keys), 'with every model present the dbt graph is used');

  // …and the same manifest minus the Silver model: a truncated graph is NOT dbt's answer.
  const partial = full.filter((n) => n.key[1] !== 'silver_order_customer');
  assert.equal(graphLineage(composition, partial, keys), null, 'one missing model ⇒ fall back to the registry');
  // And the registry graph (the fallback) is complete and honestly labelled.
  assert.equal(lineageFor(composition).source, 'registry');
});
