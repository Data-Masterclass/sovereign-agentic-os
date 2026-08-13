/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSuggestedDatasets,
  boundDummyRows,
  dummyGridFromRows,
  storyImpliesData,
  storiesImplyingData,
  unresolvedDataNeedWarning,
  DUMMY_ROWS_DEFAULT,
  DUMMY_ROWS_MAX,
} from './data-plan.ts';

// ---------------------------------------------------------- normalize/validate

test('normalizeSuggestedDatasets keeps well-formed items, requires a real column list', () => {
  const out = normalizeSuggestedDatasets([
    { name: 'employees', purpose: 'staff directory', columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }], fill: 'dummy', rows: 10 },
    { name: 'empty schema', columns: [{ name: 'a', type: 'string' }], fill: 'empty' },
    { name: 'no columns', columns: [], fill: 'dummy' }, // dropped — a real column list is required
    { name: '', columns: [{ name: 'x', type: 'string' }] }, // dropped — no name
    { columns: [{ name: 'x', type: 'string' }] }, // dropped — no name
    'not an object', // dropped
  ]);
  assert.ok(out, 'returns an array');
  assert.equal(out!.length, 2, 'only the two valid items survive');
  const [emp, empty] = out!;
  assert.equal(emp.name, 'employees');
  assert.equal(emp.fill, 'dummy');
  assert.equal(emp.rows, 10, 'bounded rows preserved');
  assert.deepEqual(emp.columns.map((c) => c.name), ['id', 'name']);
  assert.equal(empty.fill, 'empty');
  assert.equal(empty.rows, undefined, 'empty carries no row count');
});

test('normalizeSuggestedDatasets defaults an unknown fill to empty and de-dups columns', () => {
  const out = normalizeSuggestedDatasets([
    { name: 'x', columns: [{ name: 'A' }, { name: 'a' }, { name: 'b', type: 'int' }], fill: 'bogus' },
  ]);
  assert.equal(out!.length, 1);
  assert.equal(out![0].fill, 'empty', 'unknown fill → empty (safe, no generation)');
  assert.deepEqual(out![0].columns.map((c) => c.name), ['A', 'b'], 'case-insensitive de-dup, first wins');
  assert.equal(out![0].columns[0].type, 'string', 'missing type defaults to string');
});

test('normalizeSuggestedDatasets returns undefined when nothing valid remains', () => {
  assert.equal(normalizeSuggestedDatasets([{ name: 'x', columns: [] }]), undefined);
  assert.equal(normalizeSuggestedDatasets('nope'), undefined);
  assert.equal(normalizeSuggestedDatasets(undefined), undefined);
});

test('boundDummyRows clamps to [1, MAX] and defaults when absent', () => {
  assert.equal(boundDummyRows(undefined), DUMMY_ROWS_DEFAULT);
  assert.equal(boundDummyRows(0), 1);
  assert.equal(boundDummyRows(9999), DUMMY_ROWS_MAX);
  assert.equal(boundDummyRows(30), 30);
  assert.equal(boundDummyRows(NaN), DUMMY_ROWS_DEFAULT);
});

// ------------------------------------------------------------- dummy → Grid ---

test('dummyGridFromRows folds row objects into column-ordered string cells', () => {
  const cols = [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }, { name: 'active', type: 'bool' }];
  const grid = dummyGridFromRows(cols, [
    { name: 'Ada', id: 1, active: true, extra: 'ignored' },
    { id: 2, name: 'Grace' }, // missing 'active' → ''
    'not a row', // skipped
  ]);
  assert.deepEqual(grid.columns, ['id', 'name', 'active']);
  assert.deepEqual(grid.rows, [
    ['1', 'Ada', 'true'],
    ['2', 'Grace', ''],
  ]);
});

test('dummyGridFromRows bounds the row count', () => {
  const cols = [{ name: 'n', type: 'int' }];
  const many = Array.from({ length: 500 }, (_, i) => ({ n: i }));
  const grid = dummyGridFromRows(cols, many, 3);
  assert.equal(grid.rows.length, 3);
});

// ------------------------------------------------------------- build gate -----

test('storyImpliesData detects data-shaped stories, ignores pure-UI ones', () => {
  assert.equal(storyImpliesData({ title: 'List all employees' }), true);
  assert.equal(storyImpliesData({ iWant: 'to filter and sort the orders table' }), true);
  assert.equal(storyImpliesData({ spec: { features: ['Export records to CSV'] } }), true);
  assert.equal(storyImpliesData({ title: 'Show a welcome splash', iWant: 'a nice animation' }), false);
});

test('unresolvedDataNeedWarning fires only when no dataset is bound AND a story needs data', () => {
  const epics = [{ stories: [{ title: 'List all employees' }, { title: 'Pretty landing page' }] }];
  const warn = unresolvedDataNeedWarning(epics, 0);
  assert.match(warn, /1 story needs data/);
  assert.match(warn, /List all employees/);
  assert.match(warn, /bind an existing dataset or create one/);
  // A bound dataset silences it.
  assert.equal(unresolvedDataNeedWarning(epics, 1), '');
  // No data-shaped story silences it even with zero grants.
  assert.equal(unresolvedDataNeedWarning([{ stories: [{ title: 'Pretty landing page' }] }], 0), '');
});

test('unresolvedDataNeedWarning uses no-code framing for a declarative (spec) app', () => {
  const epics = [{ stories: [{ title: 'List all employees' }] }];
  // Coded default: the "no schema to write against" framing (an agent writes code).
  assert.match(unresolvedDataNeedWarning(epics, 0), /no schema to write against/);
  // Declarative: read-tabs-need-data framing, NEVER the coded "write against" language.
  const spec = unresolvedDataNeedWarning(epics, 0, 'spec');
  assert.doesNotMatch(spec, /schema to write against/);
  assert.match(spec, /Tabs that read data need a granted dataset/);
  // Still fires only on the same conditions (bound dataset silences it).
  assert.equal(unresolvedDataNeedWarning(epics, 1, 'spec'), '');
});

test('storiesImplyingData names each data-needing story', () => {
  const names = storiesImplyingData([
    { stories: [{ title: 'Browse the case ledger' }, { title: 'Static about page' }] },
    { stories: [{ title: 'Search customer directory' }] },
  ]);
  assert.deepEqual(names, ['Browse the case ledger', 'Search customer directory']);
});
