/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ChartSpec, fromTiles, fromAgent, sameDashboard, supersetBundle, viewFor } from './model.ts';
import { goldSales } from '../metrics/fixtures.ts';

const charts: ChartSpec[] = [
  { name: 'Revenue', vizType: 'big_number_total', metric: 'Sales.revenue' },
  { name: 'Revenue by region', vizType: 'bar', metric: 'Sales.revenue', dimensions: ['Sales.region'] },
];

test('dual-mode: drag-drop and the agent converge on the SAME dashboard', () => {
  const view = viewFor(goldSales());
  const dragged = fromTiles('Sales Overview', view, charts);
  const agentBuilt = fromAgent({ name: 'Sales Overview', view, charts: [...charts].reverse() });
  assert.ok(sameDashboard(dragged, agentBuilt), 'both modes produce one dashboard');
});

test('charts are deduped so the two modes cannot double-add a tile', () => {
  const view = viewFor(goldSales());
  const spec = fromTiles('S', view, [charts[0], charts[0], charts[1]]);
  assert.equal(spec.charts.length, 2);
});

test('the Superset bundle binds the dataset to the Cube view and keeps governed members', () => {
  const view = viewFor(goldSales());
  const bundle = JSON.parse(supersetBundle(fromTiles('Sales Overview', view, charts)));
  assert.equal(bundle.dataset.schema, 'cube');
  assert.match(bundle.dataset.sql, /FROM "Sales"/);
  assert.equal(bundle.charts[0].metric, 'Sales.revenue');
});
