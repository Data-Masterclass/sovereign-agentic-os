/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, toggleGroupSelection, groupState, type TableRef } from './catalog-selection.ts';

/**
 * The pure tri-state group-toggle semantics of the shared CatalogBrowser (Phase A): selecting a
 * whole schema/category adds every table; clicking again when ALL are on clears them; a PARTIAL
 * group fills to all (never toggles individually). No React — just the Set math.
 */
const tables: TableRef[] = [
  { schema: 'public', table: 'orders' },
  { schema: 'public', table: 'customers' },
  { schema: 'public', table: 'refunds' },
];

test('keyOf is schema.table', () => {
  assert.equal(keyOf({ schema: 'public', table: 'orders' }), 'public.orders');
});

test('toggling a group with NONE selected adds every table', () => {
  const next = toggleGroupSelection(new Set(), tables);
  assert.deepEqual([...next].sort(), ['public.customers', 'public.orders', 'public.refunds']);
});

test('toggling a group with ALL selected clears every table', () => {
  const all = new Set(tables.map(keyOf));
  const next = toggleGroupSelection(all, tables);
  assert.equal(next.size, 0);
});

test('toggling a PARTIALLY selected group fills it to all (does not clear)', () => {
  const some = new Set(['public.orders']);
  const next = toggleGroupSelection(some, tables);
  assert.deepEqual([...next].sort(), ['public.customers', 'public.orders', 'public.refunds']);
});

test('a group toggle leaves OTHER selections untouched', () => {
  const withOther = new Set(['staging.raw_events']);
  const next = toggleGroupSelection(withOther, tables);
  assert.ok(next.has('staging.raw_events'), 'unrelated selection is preserved');
  assert.equal(next.size, 4);
});

test('groupState reports none / some / all correctly', () => {
  assert.equal(groupState(new Set(), tables), 'none');
  assert.equal(groupState(new Set(['public.orders']), tables), 'some');
  assert.equal(groupState(new Set(tables.map(keyOf)), tables), 'all');
});

test('an empty group is never "all" (guards a vacuous tri-state)', () => {
  assert.equal(groupState(new Set(['x.y']), []), 'none');
  assert.equal(toggleGroupSelection(new Set(['x.y']), []).size, 1); // no-op on empty group
});
