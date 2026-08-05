/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The Science assistant GROUNDING — `validateDefinition` refuses a suggestion that names a
 * dataset the caller can't see or a column that doesn't exist, and trusts only real ids/columns.
 * We stub the governed data store + query so the validator is exercised deterministically: the
 * "visible" feed is a fixed dataset with a fixed column list.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const DATASETS = {
  mine: [{ id: 'ds_sales', name: 'Sales', domain: 'acme', versions: { bronze: { built: true }, silver: { built: false }, gold: { built: true } } }],
  domain: [],
  marketplace: [],
};

mock.module('@/lib/data/store', {
  namedExports: {
    listDatasets: () => DATASETS,
    getDataset: (id: string) => {
      const d = DATASETS.mine.find((x) => x.id === id);
      if (!d) throw new Error('403');
      return d;
    },
    builtLayerFqn: () => ({ layer: 'gold', fqn: 'acme.sales', principal: 'acme' }),
  },
});

mock.module('@/lib/data/dataset-schema', { namedExports: { LAYERS: ['bronze', 'silver', 'gold'] } });
mock.module('@/lib/data/profile', {
  namedExports: { parseDescribe: () => [{ name: 'churned', type: 'boolean' }, { name: 'recency_days', type: 'integer' }, { name: 'monetary_value', type: 'double' }] },
});
mock.module('@/lib/data/store-fqn', { namedExports: { slug: (s: string) => s.toLowerCase() } });
mock.module('@/lib/infra/governed', { namedExports: { queryRun: async () => ({ engine: 'trino', tables: [], columns: [], rows: [], rowCount: 0 }) } });

const { validateDefinition, visibleDatasets } = await import('./assistant-grounding.ts');

const USER = { id: 'u1', domains: ['acme'], role: 'builder' as const };

test('visibleDatasets resolves the caller feed with fqn', () => {
  const v = visibleDatasets(USER);
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 'ds_sales');
  assert.equal(v[0].fqn, 'acme.sales');
});

test('validateDefinition trusts a real dataset + real columns', async () => {
  const r = await validateDefinition(
    { datasetId: 'ds_sales', targetColumn: 'churned', features: ['recency_days', 'monetary_value'], taskType: 'binary_classification' },
    USER,
  );
  assert.ok('definition' in r);
  if ('definition' in r) {
    assert.equal(r.definition.datasetName, 'Sales');
    assert.equal(r.definition.targetColumn, 'churned');
    assert.deepEqual(r.definition.features, ['recency_days', 'monetary_value']);
  }
});

test('validateDefinition REFUSES a dataset the caller cannot see (hallucinated)', async () => {
  const r = await validateDefinition({ datasetId: 'ds_ghost', targetColumn: 'x' }, USER);
  assert.ok('error' in r);
  if ('error' in r) assert.match(r.error, /cannot see/);
});

test('validateDefinition REFUSES a target column that does not exist', async () => {
  const r = await validateDefinition({ datasetId: 'ds_sales', targetColumn: 'not_a_column' }, USER);
  assert.ok('error' in r);
  if ('error' in r) assert.match(r.error, /target column/);
});

test('validateDefinition drops invented feature columns, keeps real ones', async () => {
  const r = await validateDefinition(
    { datasetId: 'ds_sales', targetColumn: 'churned', features: ['recency_days', 'made_up_feature'] },
    USER,
  );
  assert.ok('definition' in r);
  if ('definition' in r) assert.deepEqual(r.definition.features, ['recency_days']);
});
