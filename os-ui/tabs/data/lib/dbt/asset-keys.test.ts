/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dataset → Dagster asset keys and launch selections
 * USER STORY: As a maintainer I want proof that a launch selects the dataset's OWN models plus the
 *             models that read it, that the tested asset is the furthest model (or the out-of-band
 *             source when a higher layer was authored), and that nothing else is selected.
 * ARCHITECTURE: pure over a hand-built `ProjectSnapshot` — the same input the generator takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datasetAssetKeys, selectionForBuild, selectionForSync } from '@tabs/data/lib/dbt/asset-keys';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { parseDataset } from '@tabs/data/lib/dataset-schema';
import type { Dataset } from '@tabs/data/lib/dataset-schema';

function ds(over: Record<string, unknown>): Dataset {
  return parseDataset(
    JSON.stringify({
      id: 'ds_x', name: 'X', domain: 'sales', owner: 'amir', tier: 'dataset', origin: 'ingested',
      description: '', columns: [{ name: 'order_id' }],
      versions: { bronze: { built: true }, silver: { built: false }, gold: { built: false } },
      ...over,
    }),
  );
}

const SILVER_BODY = 'create or replace table iceberg.personal_amir.silver_orders as select * from iceberg.personal_amir.bronze_orders';

function snapshot(): ProjectSnapshot {
  const orders = ds({
    id: 'ds_orders', name: 'Orders',
    checks: [{ id: 'c1', name: 'oid', rule: 'not_null', column: 'order_id' }],
    versions: {
      bronze: { built: true, artifact: 'bronze/o.yml' },
      silver: { built: true, artifact: 'silver/stg_orders.sql' },
      gold: { built: false },
    },
  });
  const mart = ds({
    id: 'ds_mart', name: 'Mart', origin: 'curated',
    upstreams: [{ datasetId: 'ds_orders', name: 'Orders', fqn: 'iceberg.personal_amir.silver_orders', joinType: 'inner' }],
    versions: { bronze: { built: false }, silver: { built: false }, gold: { built: true, artifact: 'gold/mart.sql' } },
  });
  return {
    domain: 'sales',
    datasets: [
      { dataset: orders, artifacts: { 'silver/stg_orders.sql': SILVER_BODY }, compiled: ['silver/stg_orders.sql'] },
      { dataset: mart, artifacts: { 'gold/mart.sql': 'create or replace table iceberg.personal_amir.gold_mart as select 1 as x' }, compiled: ['gold/mart.sql'] },
    ],
    catalogs: {},
  };
}

test('a dataset maps to its own models, the tested model and the models that read it', () => {
  const keys = datasetAssetKeys(snapshot(), 'ds_orders');
  assert.deepEqual(keys.models.map((m) => [m.layer, m.key]), [['silver', ['sales', 'silver_orders']]]);
  assert.deepEqual(keys.tested, ['sales', 'silver_orders']);
  assert.deepEqual(keys.dependents, [['sales', 'gold_mart']]);
});

test('selectionForBuild starts at the built layer and includes dependents; sync takes every model', () => {
  const keys = datasetAssetKeys(snapshot(), 'ds_orders');
  assert.deepEqual(selectionForBuild(keys, 'silver'), [['sales', 'silver_orders'], ['sales', 'gold_mart']]);
  assert.deepEqual(selectionForBuild(keys, 'gold'), [['sales', 'gold_mart']], 'a layer with no model of its own still rebuilds downstream');
  assert.deepEqual(selectionForSync(keys), [['sales', 'silver_orders'], ['sales', 'gold_mart']]);
});

test('a dataset nothing reads has no dependents, and an unknown id selects nothing', () => {
  const keys = datasetAssetKeys(snapshot(), 'ds_mart');
  assert.deepEqual(keys.dependents, []);
  assert.deepEqual(keys.tested, ['sales', 'gold_mart']);
  const none = datasetAssetKeys(snapshot(), 'ds_nope');
  assert.deepEqual(none, { models: [], tested: null, dependents: [] });
  assert.deepEqual(selectionForSync(none), []);
});

test('an AUTHORED (non-compiled) layer is a SOURCE: the tested asset is the source key, not a model', () => {
  const snap = snapshot();
  // Same dataset, but the silver body carries no compiled provenance.
  snap.datasets[0] = { dataset: snap.datasets[0].dataset, artifacts: { 'silver/stg_orders.sql': SILVER_BODY }, compiled: [] };
  const keys = datasetAssetKeys(snap, 'ds_orders');
  assert.deepEqual(keys.models, [], 'an authored layer must never be a dbt model');
  assert.deepEqual(keys.tested, ['sales', 'personal_amir', 'silver_orders'], 'tests attach to the source');
  assert.deepEqual(selectionForSync(keys), [['sales', 'gold_mart']], 'only the downstream model is launchable');
});
