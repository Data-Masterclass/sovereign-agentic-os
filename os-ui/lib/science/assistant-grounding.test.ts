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
const COLS = [
  { name: 'churned', type: 'boolean' },
  { name: 'recency_days', type: 'integer' },
  { name: 'monetary_value', type: 'double' },
  { name: 'duration_days', type: 'double' },
];
mock.module('@/lib/data/profile', {
  namedExports: {
    parseDescribe: () => COLS,
    previewSql: (fqn: string, limit = 50) => `select * from ${fqn} limit ${limit}`,
    // Real classifier (mirrors the module) so targetProfile knows which columns are numeric.
    classifyType: (t: string) => (/^(tinyint|smallint|integer|int|bigint|real|double|decimal|numeric)\b/.test((t || '').toLowerCase()) ? 'numeric' : (t || '').toLowerCase() === 'boolean' ? 'boolean' : 'string'),
  },
});
mock.module('@/lib/data/store-fqn', { namedExports: { slug: (s: string) => s.toLowerCase() } });
// The per-target content profile the stubbed governed query returns (distinct/non-null/frac).
// duration_days = a continuous double (many distinct, fractional values present → regression).
const PROFILE: Record<string, { n: number; distinct_n: number; non_null: number; frac?: number }> = {
  duration_days: { n: 1000, distinct_n: 640, non_null: 1000, frac: 512 }, // fractional ⇒ continuous
  churned: { n: 1000, distinct_n: 2, non_null: 1000, frac: 0 },
  recency_days: { n: 1000, distinct_n: 45, non_null: 1000, frac: 0 },
};
// A governed query stub that answers DESCRIBE, the content-profile SELECT, and the row-sample SELECT.
mock.module('@/lib/infra/governed', {
  namedExports: {
    queryRun: async (sql: string) => {
      if (/^\s*describe/i.test(sql)) {
        return { engine: 'trino', tables: [], columns: ['Column', 'Type'], rows: COLS.map((c) => [c.name, c.type]), rowCount: COLS.length };
      }
      // Content profile: `select count(*) as n, count(distinct "<t>") as distinct_n, ...`.
      const m = /count\(distinct "([^"]+)"\)/i.exec(sql);
      if (/count\(\*\) as n/i.test(sql) && m) {
        const p = PROFILE[m[1]] ?? { n: 0, distinct_n: 0, non_null: 0 };
        const numeric = /count_if\(/i.test(sql);
        const columns = ['n', 'distinct_n', 'non_null', ...(numeric ? ['frac'] : [])];
        const row = [String(p.n), String(p.distinct_n), String(p.non_null), ...(numeric ? [String(p.frac ?? 0)] : [])];
        return { engine: 'trino', tables: [], columns, rows: [row], rowCount: 1 };
      }
      // SELECT * … LIMIT n → two real sample rows over the columns.
      return {
        engine: 'trino', tables: [], columns: ['churned', 'recency_days', 'monetary_value', 'duration_days'],
        rows: [['true', '12', '340.5', '5.5'], ['false', '3', '1290.0', '18.0']], rowCount: 2,
      };
    },
  },
});

const { validateDefinition, visibleDatasets, datasetColumnsTyped, datasetSample, designGrounding, targetProfile, GROUNDING_SAMPLE_ROWS } = await import('./assistant-grounding.ts');

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
  assert.deepEqual(sample!.columns, ['churned', 'recency_days', 'monetary_value', 'duration_days']);
  assert.equal(sample!.rows.length, 2);
  assert.deepEqual(sample!.rows[0], ['true', '12', '340.5', '5.5']);
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

/* ── 0.6.111 auto-detect the ML task from the target column (dtype + content) ── */

test('targetProfile reads the target column content (distinct/non-null + integer-valued)', async () => {
  const p = await targetProfile('ds_sales', 'duration_days', 'double', USER);
  assert.ok(p);
  assert.equal(p!.distinctCount, 640);
  assert.equal(p!.nonNull, 1000);
  assert.equal(p!.isIntegerValued, false); // fractional values present ⇒ continuous
});

test('validateDefinition OVERRIDES classification-on-continuous → regression + flags it', async () => {
  // The owner's exact bug: binary_classification proposed on a continuous `duration_days` double.
  const r = await validateDefinition(
    { datasetId: 'ds_sales', targetColumn: 'duration_days', features: ['recency_days', 'monetary_value'], taskType: 'binary_classification' },
    USER,
  );
  assert.ok('definition' in r);
  if ('definition' in r) {
    assert.equal(r.definition.taskType, 'regression');
    assert.equal(r.definition.autoDetectedTask, true);
    assert.match(r.definition.autoDetectedReason ?? '', /regression/i);
    assert.match(r.definition.autoDetectedReason ?? '', /duration_days/);
  }
});

test('validateDefinition FILLS a missing task from the target and flags it', async () => {
  const r = await validateDefinition(
    { datasetId: 'ds_sales', targetColumn: 'duration_days', features: ['recency_days'] },
    USER,
  );
  assert.ok('definition' in r);
  if ('definition' in r) {
    assert.equal(r.definition.taskType, 'regression');
    assert.equal(r.definition.autoDetectedTask, true);
  }
});

test('validateDefinition KEEPS a task already consistent with the target (no flag)', async () => {
  // churned has 2 distinct values → binary; a proposed binary is consistent, kept, unflagged.
  const r = await validateDefinition(
    { datasetId: 'ds_sales', targetColumn: 'churned', features: ['recency_days'], taskType: 'binary_classification' },
    USER,
  );
  assert.ok('definition' in r);
  if ('definition' in r) {
    assert.equal(r.definition.taskType, 'binary_classification');
    assert.ok(!r.definition.autoDetectedTask);
  }
});

test('validateDefinition OVERRIDES regression-on-binary → binary_classification', async () => {
  const r = await validateDefinition(
    { datasetId: 'ds_sales', targetColumn: 'churned', features: ['recency_days'], taskType: 'regression' },
    USER,
  );
  assert.ok('definition' in r);
  if ('definition' in r) {
    assert.equal(r.definition.taskType, 'binary_classification');
    assert.equal(r.definition.autoDetectedTask, true);
  }
});
