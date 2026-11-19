/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One bad dataset never breaks a domain's dbt project (live incident 2026-11, track H)
 * USER STORY: As a domain owner I want a quality rule recorded twice to produce ONE dbt test — not a
 *             project `dbt parse` refuses — and any dataset whose files dbt would refuse to be left
 *             out of the project and reported, so every other dataset keeps syncing.
 * ARCHITECTURE:
 *   - The live shape: production domain repos carried `- not_null` / `- unique` twice on one column
 *     (a rule applied twice). dbt-core 1.9.11 (the image's pin) refuses that at `dbt parse` with
 *     `dbt found two data_tests with the name "not_null_<model>_<column>"` — reproduced against the
 *     generator's own output in the production Dagster image before this fix.
 *   - Pure: literal datasets, the real generator, no store, no dbt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { emptyVersions, type Dataset, type DataCheck } from '@tabs/data/lib/dataset-schema';
import { generateProject, generateProjectReport, SKIPPED_PATH } from '@tabs/data/lib/dbt/generate';
import { checkProject } from '@tabs/data/lib/dbt/project-check';
import { checksToColumnTests } from '@tabs/data/lib/dbt/schema';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

const built = (artifact: string, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });

function chk(id: string, rule: DataCheck['rule'], column: string, extra: Partial<DataCheck> = {}): DataCheck {
  return { id, name: `${rule} ${column}`, description: '', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z', rule, column, ...extra };
}

function ds(id: string, slug: string, checks: DataCheck[]): Dataset {
  return {
    version: '1', tier: 'dataset', visibility: 'private', folder: '/', description: '', grants: [], measures: [], viewNamespaced: true,
    id, name: slug.replace(/_/g, ' '), owner: 'amir', domain: 'sales',
    columns: [{ name: 'po_number', description: 'PO' }, { name: 'qty', description: 'Qty' }],
    checks,
    versions: { ...emptyVersions(), bronze: built(`bronze/${slug}.dlt.yml`), silver: built(`silver/${slug}.sql`, true), gold: built(`gold/${slug}.sql`, true) },
  } as Dataset;
}

const snap = (...datasets: Dataset[]): ProjectSnapshot => ({ domain: 'sales', datasets: datasets.map((dataset) => ({ dataset, artifacts: {} })), catalogs: {} });

// The live input: every rule recorded twice on the same column.
const REPEATED = [
  chk('c1', 'not_null', 'po_number'), chk('c2', 'unique', 'po_number'),
  chk('c3', 'not_null', 'po_number'), chk('c4', 'unique', 'po_number'),
  chk('c5', 'range', 'qty', { min: 0 }), chk('c6', 'range', 'qty', { min: 0 }),
];

function goldTests(files: Map<string, string>, model: string): Record<string, unknown[]> {
  const doc = yaml.load(files.get('models/personal/amir/schema.yml')!) as { models: { name: string; columns?: { name: string; data_tests?: unknown[] }[] }[] };
  const m = doc.models.find((x) => x.name === model)!;
  return Object.fromEntries((m.columns ?? []).map((c) => [c.name, c.data_tests ?? []]));
}

test('a rule recorded twice on a column is emitted as ONE dbt test (the live dbt parse failure)', () => {
  const files = generateProject('sales', snap(ds('ds_receipts1', 'goods_receipts', REPEATED)));
  const t = goldTests(files, 'gold_goods_receipts');
  assert.deepEqual(t.po_number, ['not_null', 'unique']);
  assert.deepEqual(t.qty, [{ range: { min: 0 } }]);
  assert.deepEqual(checkProject(files), [], 'the generated project passes the structural check');
  assert.equal(files.has(SKIPPED_PATH), false, 'nothing was skipped — de-duplicating loses no rule');
});

test('different tests of the same kind on one column are KEPT (dbt gives them distinct ids)', () => {
  const { tests } = checksToColumnTests([
    chk('a', 'range', 'qty', { min: 0 }), chk('b', 'range', 'qty', { max: 0 }), chk('c', 'range', 'qty', { max: 0, min: 0 }), chk('d', 'range', 'qty', { min: 0, max: 0 }),
    chk('e', 'accepted_values', 'po_number', { values: ['a'] }), chk('f', 'accepted_values', 'po_number', { values: ['a', 'b'] }),
  ]);
  assert.deepEqual(tests.get('qty'), [{ range: { min: 0 } }, { range: { max: 0 } }, { range: { min: 0, max: 0 } }], 'key order does not make a test different');
  assert.equal(tests.get('po_number')!.length, 2);
});

test('checkProject flags the pre-fix shape and pins it on the dataset that caused it', () => {
  const files = new Map<string, string>([
    ['models/personal/amir/gold_x.sql', "-- gold_x — gold layer of OS dataset ds_x (\"X\", domain sales).\nselect * from {{ ref('silver_x') }}\n"],
    ['models/personal/amir/silver_x.sql', "-- silver_x — silver layer of OS dataset ds_x (\"X\", domain sales).\nselect * from {{ source('personal_amir', 'bronze_x') }}\n"],
    ['models/personal/amir/gold_y.sql', "-- gold_y — gold layer of OS dataset ds_y (\"Y\", domain sales).\nselect * from {{ ref('silver_gone') }}\n"],
    ['models/sources.yml', yaml.dump({ version: 2, sources: [{ name: 'personal_amir', schema: 'personal_amir', tables: [{ name: 'bronze_x', description: 'Bronze landing of OS dataset ds_x ("X").' }] }] })],
    ['models/personal/amir/schema.yml', yaml.dump({ version: 2, models: [{ name: 'gold_x', config: { meta: { os_dataset: 'ds_x' } }, columns: [{ name: 'po_number', data_tests: ['not_null', 'unique', 'not_null'] }] }] })],
  ]);
  const issues = checkProject(files);
  assert.equal(issues.length, 2);
  const dup = issues.find((i) => i.datasetId === 'ds_x')!;
  assert.match(dup.reason, /column 'po_number' of 'gold_x' carries the same 'not_null' test twice/);
  const ref = issues.find((i) => i.datasetId === 'ds_y')!;
  assert.match(ref.reason, /ref\('silver_gone'\) names a model that is not in the project/);
});

test('checkProject: duplicate model names, an undeclared source and unparseable YAML are refused', () => {
  const files = new Map<string, string>([
    ['models/gold/gold_a.sql', '-- gold_a — gold layer of OS dataset ds_a ("A").\nselect 1\n'],
    ['models/personal/amir/gold_a.sql', "-- gold_a — gold layer of OS dataset ds_b (\"B\").\nselect * from {{ source('nope', 't') }}\n"],
    ['models/gold/schema.yml', 'version: 2\nmodels: [\n'],
  ]);
  const issues = checkProject(files);
  assert.ok(issues.some((i) => i.datasetId === 'ds_b' && /two dbt models are named 'gold_a'/.test(i.reason)));
  assert.ok(issues.some((i) => i.datasetId === 'ds_a' && /two dbt models are named 'gold_a'/.test(i.reason)));
  assert.ok(issues.some((i) => i.datasetId === 'ds_b' && /source\('nope', 't'\) is not declared/.test(i.reason)));
  assert.ok(issues.some((i) => i.datasetId === null && /not valid YAML/.test(i.reason)));
});

test('ONE invalid dataset is left out and reported; every other dataset is still generated', () => {
  const good = ds('ds_good', 'goods_receipts', [chk('g1', 'not_null', 'po_number')]);
  const bad = ds('ds_bad', 'broken_orders', [chk('b1', 'not_null', 'po_number')]);
  // Whatever rule a future dbt release adds: the generator's response to an attributed issue is
  // the same, so the check is injected here to pin THAT behaviour.
  const check = (files: Map<string, string>) =>
    [...files.keys()].some((p) => p.includes('broken_orders')) ? [{ datasetId: 'ds_bad', path: 'models/personal/amir/schema.yml', reason: 'dbt would refuse it' }] : [];
  const { files, skipped } = generateProjectReport('sales', snap(good, bad), { check });
  assert.deepEqual(skipped, [{ dataset: 'ds_bad', reason: 'dbt would refuse it (models/personal/amir/schema.yml)' }]);
  assert.ok(files.has('models/personal/amir/gold_goods_receipts.sql'), 'the good dataset is still in the project');
  assert.ok(![...files.keys()].some((p) => p.includes('broken_orders')), 'the bad dataset left no file behind');
  assert.deepEqual(yaml.load(files.get(SKIPPED_PATH)!), { version: 1, skipped: [{ dataset: 'ds_bad', reason: 'dbt would refuse it (models/personal/amir/schema.yml)' }] });
  assert.deepEqual([...files.keys()], [...files.keys()].sort(), 'still sorted (byte-stable tree)');
});

test('an issue that names no dataset cannot be skipped, so generation does not loop or drop anything', () => {
  const good = ds('ds_good', 'goods_receipts', []);
  const { files, skipped } = generateProjectReport('sales', snap(good), { check: () => [{ datasetId: null, path: 'dbt_project.yml', reason: 'x' }] });
  assert.deepEqual(skipped, []);
  assert.ok(files.has('models/personal/amir/gold_goods_receipts.sql'));
});
