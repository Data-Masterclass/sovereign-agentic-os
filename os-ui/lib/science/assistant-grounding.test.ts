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
    listDatasets: (u: { id?: string }) => (u?.id === 'nobody' ? { mine: [], domain: [], marketplace: [] } : DATASETS),
    getDataset: (id: string) => {
      const d = DATASETS.mine.find((x) => x.id === id);
      if (!d) throw new Error('403');
      return d;
    },
    builtLayerFqn: () => ({ layer: 'gold', fqn: 'acme.sales', principal: 'acme' }),
  },
});

mock.module('@/lib/data/dataset-schema', { namedExports: { LAYERS: ['bronze', 'silver', 'gold'] } });
const COLS = [{ name: 'churned', type: 'boolean' }, { name: 'recency_days', type: 'integer' }, { name: 'monetary_value', type: 'double' }];
mock.module('@/lib/data/profile', {
  namedExports: {
    parseDescribe: () => COLS,
    previewSql: (fqn: string, limit = 50) => `select * from ${fqn} limit ${limit}`,
  },
});
mock.module('@/lib/data/store-fqn', { namedExports: { slug: (s: string) => s.toLowerCase() } });
// A governed query stub that answers DESCRIBE and SELECT differently so the sample path has rows.
mock.module('@/lib/infra/governed', {
  namedExports: {
    queryRun: async (sql: string) => {
      if (/^\s*describe/i.test(sql)) {
        return { engine: 'trino', tables: [], columns: ['Column', 'Type'], rows: COLS.map((c) => [c.name, c.type]), rowCount: COLS.length };
      }
      // SELECT * … LIMIT n → two real sample rows over the three columns.
      return {
        engine: 'trino', tables: [], columns: ['churned', 'recency_days', 'monetary_value'],
        rows: [['true', '12', '340.5'], ['false', '3', '1290.0']], rowCount: 2,
      };
    },
  },
});

const { validateDefinition, visibleDatasets, datasetColumnsTyped, datasetSample, designGrounding, GROUNDING_SAMPLE_ROWS } = await import('./assistant-grounding.ts');

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

/* ── 0.6.99 grounding: columns (name+type) + sample VALUES, DLS-scoped, still bounded/honest ── */

test('datasetColumnsTyped returns real columns WITH their types', async () => {
  const cols = await datasetColumnsTyped('ds_sales', USER);
  assert.deepEqual(cols, COLS);
});

test('datasetColumnsTyped returns [] for a dataset the caller cannot see (DLS-scoped)', async () => {
  const cols = await datasetColumnsTyped('ds_ghost', USER);
  assert.deepEqual(cols, []);
});

test('datasetSample returns a small set of REAL rows (default budget)', async () => {
  const sample = await datasetSample('ds_sales', USER);
  assert.ok(sample);
  assert.deepEqual(sample!.columns, ['churned', 'recency_days', 'monetary_value']);
  assert.equal(sample!.rows.length, 2);
  assert.deepEqual(sample!.rows[0], ['true', '12', '340.5']);
  assert.ok(GROUNDING_SAMPLE_ROWS >= 1);
});

test('datasetSample is null for a dataset the caller cannot see (never fabricated)', async () => {
  assert.equal(await datasetSample('ds_ghost', USER), null);
});

test('designGrounding lists visible datasets with columns AND types, and sample VALUES for the selected one', async () => {
  const g = await designGrounding(USER, 'ds_sales');
  // columns for the visible set, WITH types (name:type)
  assert.match(g, /ds_sales — Sales \[personal\]/);
  assert.match(g, /churned:boolean/);
  assert.match(g, /recency_days:integer/);
  // sample VALUES for the selected dataset (real rows)
  assert.match(g, /Sample of the selected dataset \(Sales, ds_sales\)/);
  assert.match(g, /340\.5/);
});

test('designGrounding omits sample values when no dataset is selected (columns only)', async () => {
  const g = await designGrounding(USER, '');
  assert.match(g, /churned:boolean/);
  assert.doesNotMatch(g, /Sample of the selected dataset/);
});

test('designGrounding is honest when the caller has no datasets', async () => {
  const g = await designGrounding({ id: 'nobody', domains: [], role: 'creator' as const }, 'ds_sales');
  assert.match(g, /no datasets yet/);
});
