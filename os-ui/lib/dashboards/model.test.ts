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

test('the legacy (no-domain) Superset bundle keeps the direct-Trino shape', () => {
  const view = viewFor(goldSales());
  const bundle = JSON.parse(supersetBundle(fromTiles('Sales Overview', view, charts)));
  assert.equal(bundle.database_service_name, 'trino');
  assert.equal(bundle.dataset.schema, 'cube');
  assert.match(bundle.dataset.sql, /FROM "Sales"/);
  assert.equal(bundle.charts[0].metric, 'Sales.revenue');
});

test('a domain-scoped bundle targets the Cube SQL API as the bi_<domain> principal (real rows)', () => {
  const view = viewFor(goldSales());
  const bundle = JSON.parse(supersetBundle(fromTiles('Sales Overview', view, charts, 'sales')));
  // The database is a postgres connection to Cube SQL as bi_sales — the endpoint that
  // actually serves the view's rows (Trino iceberg has no such view).
  assert.ok(bundle.database, 'domain path carries an explicit database block');
  assert.equal(bundle.database.cube_sql, true);
  assert.match(bundle.database.sqlalchemy_uri, /^postgresql:\/\/bi_sales:.*@cube-sql:15432\/bi_sales$/);
  // The Cube view is a top-level table on that connection → no `cube` schema.
  assert.equal(bundle.dataset.schema, undefined);
  assert.match(bundle.dataset.sql, /FROM "Sales"/);
  assert.equal(bundle.database_service_name, bundle.database.service_name);
});

test('domain does not change dashboard identity (view belongs to one domain)', () => {
  const view = viewFor(goldSales());
  const withDomain = fromTiles('Sales Overview', view, charts, 'sales');
  const without = fromTiles('Sales Overview', view, charts);
  assert.ok(sameDashboard(withDomain, without));
  assert.equal(withDomain.domain, 'sales');
});

test('P0-1: supersetBundle threads operator-configured host/port into the Cube SQL URI', () => {
  const view = viewFor(goldSales());
  const spec = fromTiles('Sales Overview', view, charts, 'sales');
  // Default (no opts): falls back to the in-cluster default cube-sql:15432.
  const defaultBundle = JSON.parse(supersetBundle(spec));
  assert.match(defaultBundle.database.sqlalchemy_uri, /cube-sql:15432/);
  // Operator override: the configured host/port must appear in the URI.
  const customBundle = JSON.parse(supersetBundle(spec, { host: 'my-cube.example.com', port: 5432 }));
  assert.match(customBundle.database.sqlalchemy_uri, /my-cube\.example\.com:5432/);
  // The service name is stable regardless of host/port.
  assert.equal(customBundle.database.service_name, defaultBundle.database.service_name);
});
