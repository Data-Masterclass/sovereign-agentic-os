/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The pure grouping math behind the Organize CategoryTree (Phase B): count-sorted folders
 * with Unsorted always last, unknown category ids degrading to Unsorted, empty folders kept
 * (so an admin can move INTO them), and the search that also matches folder names + why text.
 * No React — just the assembly + filter logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolders, filterTables, UNSORTED, type Placement } from './category-tree.ts';
import type { TableRef } from './catalog-selection.ts';

const taxonomy = [
  { id: 'orders', name: 'Orders' },
  { id: 'customer', name: 'Customer' },
  { id: 'empty', name: 'Empty Folder' },
  { id: UNSORTED, name: 'Unsorted' },
];

const tables: TableRef[] = [
  { schema: 'public', table: 'orders' },
  { schema: 'public', table: 'order_items' },
  { schema: 'public', table: 'customers' },
  { schema: 'public', table: 'weird' },
];

const placements: Record<string, Placement> = {
  'public.orders': { category: 'orders', source: 'ai', confidence: 0.9, why: 'sales fact' },
  'public.order_items': { category: 'orders', source: 'ai', confidence: 0.8, why: 'line items' },
  'public.customers': { category: 'customer', source: 'override' },
  'public.weird': { category: 'ghost-folder', source: 'ai', confidence: 0.6, why: 'unclear' },
};

test('folders are count-sorted with Unsorted always last', () => {
  const folders = buildFolders(tables, taxonomy, placements);
  assert.deepEqual(folders.map((f) => f.id), ['orders', 'customer', 'empty', UNSORTED]);
});

test('an unknown category id degrades to Unsorted (never invents a folder)', () => {
  const folders = buildFolders(tables, taxonomy, placements);
  const unsorted = folders.find((f) => f.id === UNSORTED)!;
  assert.equal(unsorted.tables.length, 1);
  assert.equal(unsorted.tables[0].table, 'weird');
});

test('every taxonomy folder appears even when empty (so admins can move INTO it)', () => {
  const folders = buildFolders(tables, taxonomy, placements);
  const empty = folders.find((f) => f.id === 'empty');
  assert.ok(empty);
  assert.equal(empty!.tables.length, 0);
});

test('a table with no placement falls into Unsorted', () => {
  const folders = buildFolders(tables, taxonomy, {});
  const unsorted = folders.find((f) => f.id === UNSORTED)!;
  assert.equal(unsorted.tables.length, tables.length);
});

test('Unsorted is pinned last even when it has the most tables', () => {
  const many: Record<string, Placement> = {};
  for (const t of tables) many[`${t.schema}.${t.table}`] = { category: UNSORTED, source: 'unsorted' };
  const folders = buildFolders(tables, taxonomy, many);
  assert.equal(folders[folders.length - 1].id, UNSORTED);
});

test('filter matches table names, schema, folder names, and the AI why text', () => {
  // by table name
  assert.deepEqual(filterTables(tables, 'order_items', taxonomy, placements).map((t) => t.table), ['order_items']);
  // by folder name (Customer) — matches the customers table placed there
  assert.deepEqual(filterTables(tables, 'customer', taxonomy, placements).map((t) => t.table), ['customers']);
  // by why text
  assert.deepEqual(filterTables(tables, 'line items', taxonomy, placements).map((t) => t.table), ['order_items']);
  // empty query returns all
  assert.equal(filterTables(tables, '', taxonomy, placements).length, tables.length);
});
