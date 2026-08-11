/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  panelSourceUnavailable,
  metricSourceUnavailable,
} from './source-availability.ts';

// A resolver over a live registry: only these members resolve to a metric id.
const live = new Map<string, string>([
  ['Orders.revenue', 'ds_orders.revenue'],
  ['Orders.count', 'ds_orders.count'],
]);
const resolve = (m: string) => live.get(m);

test('panel with a live member is NOT unavailable', () => {
  assert.equal(panelSourceUnavailable(['Orders.revenue'], resolve, true), false);
});

test('panel where EVERY member is gone IS unavailable (registry ready)', () => {
  assert.equal(panelSourceUnavailable(['Gone.x', 'Gone.y'], resolve, true), true);
});

test('panel with a mix of live + gone members is NOT unavailable', () => {
  assert.equal(panelSourceUnavailable(['Orders.revenue', 'Gone.y'], resolve, true), false);
});

test('a panel with no members is never judged unavailable', () => {
  assert.equal(panelSourceUnavailable([], resolve, true), false);
});

test('while the registry is still loading we do NOT degrade', () => {
  // Every member resolves to undefined transiently during load — must not white-out the tile.
  assert.equal(panelSourceUnavailable(['Gone.y'], resolve, false), false);
});

test('metric whose datasetId is still visible is NOT unavailable', () => {
  const visible = new Set(['ds_orders', 'ds_customers']);
  assert.equal(metricSourceUnavailable('ds_orders', visible), false);
});

test('metric whose datasetId fell out of the visible set IS unavailable', () => {
  const visible = new Set(['ds_customers']);
  assert.equal(metricSourceUnavailable('ds_orders', visible), true);
});

test('a missing datasetId is unavailable (nothing to deref)', () => {
  const visible = new Set(['ds_customers']);
  assert.equal(metricSourceUnavailable(undefined, visible), true);
});

test('an empty visible set is treated as "not loaded" — do not degrade', () => {
  assert.equal(metricSourceUnavailable('ds_orders', new Set()), false);
});
