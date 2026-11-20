/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    Real-world column names, valid Unicode and a lossless git read-back under literal safety
 * USER STORY: As someone uploading `Bestellungen.csv` with `Order Date`, `größe`, `kunden-nr` and
 *             `Umsatz (€)` I want the upload to work without renaming anything, my existing
 *             datasets with such columns to stay in the domain project, and what I push back from
 *             git to read exactly as I wrote it.
 * ARCHITECTURE:
 *   - Pure: `upload-columns.ts` (header read + mapping), `literal.ts` (normalisation, `column`
 *     allow-list, well-formed Unicode), the generator, the store write path and the git read-back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { allocateColumnNames, isIdentifier, normalizeColumnName, freeText } from '@tabs/data/lib/dbt/literal';
import { planUploadColumns, uploadHeaders } from '@tabs/data/lib/upload-columns';
import { generateProjectReport } from '@tabs/data/lib/dbt/generate';
import { checkProject } from '@tabs/data/lib/dbt/project-check';
import { preflightDatasets } from '@tabs/data/lib/dbt/literal-preflight';
import { datasetsFromSchemaYml } from '@tabs/data/lib/dbt/ingest';
import { baseSnapshot } from '@tabs/data/lib/dbt/literal-fuzz';
import { parseDataset, serializeDataset, type Dataset } from '@tabs/data/lib/dataset-schema';
import { __resetStore, __seedDatasetForTest, getDataset, setDocs } from '@tabs/data/lib/store';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const GERMAN = ['Order Date', 'größe', 'kunden-nr', 'Umsatz (€)', 'Straße', 'Kunden Nr', 'Größe', '2024', 'Café', '  ', 'naïve'];

test('normalizeColumnName: the documented normalisation', () => {
  assert.deepEqual(GERMAN.map(normalizeColumnName), ['order_date', 'groesse', 'kunden_nr', 'umsatz_eur', 'strasse', 'kunden_nr', 'groesse', 'c_2024', 'cafe', 'column', 'naive']);
  for (const n of GERMAN.map(normalizeColumnName)) assert.ok(isIdentifier('sql', n), n);
});

test('allocateColumnNames: collision-free, deterministic, and a recorded mapping is never re-derived', () => {
  const first = allocateColumnNames(GERMAN);
  assert.deepEqual(first.map((p) => p.name), ['order_date', 'groesse', 'kunden_nr', 'umsatz_eur', 'strasse', 'kunden_nr_2', 'groesse_2', 'c_2024', 'cafe', 'column', 'naive']);
  assert.deepEqual(allocateColumnNames(GERMAN), first, 'deterministic');
  // Re-ingest with the headers in another order and one new header: stored names are kept.
  const stored = first.map((p) => ({ name: p.name, source: p.source }));
  const again = allocateColumnNames(['Größe', 'neu', 'Order Date', 'kunden-nr'], stored);
  assert.deepEqual(again.map((p) => p.name), ['groesse_2', 'neu', 'order_date', 'kunden_nr']);
  // A legacy column recorded under its raw header keeps it (no rename of a live table).
  assert.deepEqual(allocateColumnNames(['Order Date'], [{ name: 'Order Date' }]).map((p) => p.name), ['Order Date']);
});

test('uploadHeaders reads the header record like the data-runner (quotes, BOM, TSV); self-describing formats are not mapped', () => {
  assert.deepEqual(uploadHeaders('a.csv', Buffer.from('\uFEFF"Order Date","Umsatz, netto","Say ""hi"""\r\n1,2,3\n')), ['Order Date', 'Umsatz, netto', 'Say "hi"']);
  assert.deepEqual(uploadHeaders('a.tsv', Buffer.from('größe\tkunden-nr\n1\t2\n')), ['größe', 'kunden-nr']);
  assert.equal(uploadHeaders('a.parquet', Buffer.from('PAR1')), null);
  assert.equal(uploadHeaders('a.json', Buffer.from('{}')), null);
  const plan = planUploadColumns(['Order Date', 'id'], []);
  assert.deepEqual(plan.columnNames, ['order_date', 'id']);
  assert.deepEqual(plan.columns, [{ name: 'order_date', description: '', source: 'Order Date' }, { name: 'id', description: '' }]);
});

/** Live-shaped datasets: a legacy dataset holding raw German headers, one mapped at ingest. */
function liveShaped() {
  const s = baseSnapshot();
  const legacy = s.datasets[0].dataset as Dataset;
  legacy.columns = [
    { name: 'Order Date', description: 'Bestelldatum' },
    { name: 'größe', description: '' },
    { name: 'kunden-nr', description: 'Kundennummer {intern}' },
    { name: 'Umsatz (€)', description: '' },
    { name: 'order', description: 'reserved word' },
  ];
  legacy.checks = [{ id: 'c1', name: 'Kundennummer vorhanden', description: '', createdBy: 'amir', createdAt: '2026-11-13T00:00:00.000Z', rule: 'not_null', column: 'order' }];
  const mapped = s.datasets[1].dataset as Dataset;
  mapped.columns = [{ name: 'id', description: '' }, { name: 'updated_at', description: '', source: 'Zuletzt geändert' }];
  return s;
}

test('existing datasets with real-world column names stay in the project, quoted with dbt quote: true', () => {
  const { files, skipped } = generateProjectReport('sales', liveShaped());
  assert.deepEqual(skipped, [], 'no live-shaped dataset may drop out');
  assert.deepEqual(checkProject(files), []);
  const schema = yaml.load([...files.entries()].find(([p]) => p === 'models/silver/schema.yml')![1]) as { models: { columns: Record<string, unknown>[] }[] };
  const cols = schema.models[0].columns;
  assert.deepEqual(cols.find((c) => c.name === 'Order Date'), { name: 'Order Date', description: 'Bestelldatum', quote: true });
  assert.equal(cols.find((c) => c.name === 'kunden-nr')!.description, 'Kundennummer ｛intern｝');
  assert.equal(cols.find((c) => c.name === 'order')!.quote, true);
  const bronze = [...files.values()].join('\n');
  assert.match(bronze, /os_source_name: Zuletzt geändert/, 'the original header is kept as meta');
  assert.deepEqual(preflightDatasets(liveShaped().datasets.map((e) => e.dataset)), [], 'the preflight refuses nothing live-shaped');
});

test('the store accepts real-world column names and keeps the recorded source header across a docs save', () => {
  __resetStore();
  __seedDatasetForTest({ id: 'ds_col1', name: 'Bestellungen', owner: 'amir', domain: 'sales', columns: [{ name: 'order_date', description: '', source: 'Order Date' } as never] });
  const user = { id: 'amir', domains: ['sales'], role: 'creator' as const };
  setDocs('ds_col1', user, { columns: [{ name: 'order_date', description: 'Datum' }, { name: 'größe', description: '' }, { name: 'Umsatz (€)', description: '' }] });
  assert.deepEqual(getDataset('ds_col1', user).columns, [
    { name: 'order_date', description: 'Datum', source: 'Order Date' },
    { name: 'größe', description: '' },
    { name: 'Umsatz (€)', description: '' },
  ]);
  for (const bad of ['a{b', 'a"b', 'a\\b', 'a\nb', 'x\uD800']) {
    assert.throws(() => setDocs('ds_col1', user, { columns: [{ name: bad, description: '' }] }), /not allowed/, JSON.stringify(bad));
  }
});

test('lone surrogates: normalised at the store boundary, in free text, and caught by the project check', () => {
  const d = { ...(baseSnapshot().datasets[0].dataset as Dataset), name: 'Orders \uD800', description: 'x \uDFFF y' };
  const back = parseDataset(serializeDataset(d));
  assert.equal(back.name, 'Orders �');
  assert.equal(back.description, 'x � y');
  assert.equal(freeText('a\uD800b😀'), 'a�b😀', 'a valid pair (emoji) is kept');
  const issues = checkProject(new Map([['models/silver/schema.yml', 'version: 2\nmodels:\n  - name: m\n    description: "OS dataset ds_x1 \uD800"\n']]));
  assert.ok(issues.some((i) => /lone UTF-16 surrogate/.test(i.reason) && i.datasetId === 'ds_x1'));
});

test('git read-back decodes the encoded free text: push → read-back is lossless', () => {
  const s = baseSnapshot();
  const d = s.datasets[0].dataset as Dataset;
  d.description = 'Revenue {{ net }} per {region}';
  d.columns[0].description = 'key {id}';
  const { files } = generateProjectReport('sales', s);
  const [path, content] = [...files.entries()].find(([p]) => p === 'models/silver/schema.yml')!;
  assert.doesNotMatch(content, /[{}]/);
  const back = datasetsFromSchemaYml(path, content, 'sales')[0];
  assert.ok(back.description.endsWith('Revenue {{ net }} per {region}'), back.description);
  assert.equal(back.columns.find((c) => c.name === 'order_id')!.description, 'key {id}');
});
