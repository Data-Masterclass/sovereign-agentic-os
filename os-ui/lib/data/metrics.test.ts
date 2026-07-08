/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scaffoldCubeYaml,
  scaffoldExposureYaml,
  scaffoldDashboardBundle,
  inferDimType,
  cubeViewName,
  goldMartFqn,
} from './metrics.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';

function gold(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true; versions.silver.built = true; versions.gold.built = true;
  return {
    version: '1', id: 'ds_orders', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'asset', visibility: 'domain', description: 'Sales orders.', versions,
    grants: [], measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'order_date', description: 'When.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

test('cube_dbt scaffolds dimensions from columns; user-named measure is included', () => {
  const yaml = scaffoldCubeYaml(gold());
  assert.match(yaml, /sql_table: iceberg\.sales\.gold_orders/);
  assert.match(yaml, /name: revenue\n\s+type: sum\n\s+sql: net_amount/);
  assert.match(yaml, /name: order_id[\s\S]*primary_key: true/); // PK dimension
  assert.match(yaml, /- name: Orders/); // the view
  assert.match(yaml, /includes: \[revenue, order_date, region, net_amount\]/);
});

test('dim types are inferred cube_dbt-style from the column names', () => {
  assert.equal(inferDimType('order_date'), 'time');
  assert.equal(inferDimType('created_at'), 'time');
  assert.equal(inferDimType('net_amount'), 'number');
  assert.equal(inferDimType('customer_id'), 'number');
  assert.equal(inferDimType('is_active'), 'boolean');
  assert.equal(inferDimType('region'), 'string');
});

test('one dbt exposure per view, depending on the gold mart', () => {
  const y = scaffoldExposureYaml(gold());
  assert.match(y, /name: orders_metrics/);
  assert.match(y, /ref\('mart_orders'\)/);
  assert.match(y, /name: amir/); // owner
});

test('a dashboard bundle binds the Cube view to the query service', () => {
  const b = JSON.parse(scaffoldDashboardBundle(gold()));
  assert.equal(b.database_service_name, 'trino');
  assert.equal(b.dataset.name, 'Orders');
  assert.equal(b.charts[0].metric, 'revenue');
  assert.equal(b.depends_on_exposure, 'orders_metrics');
});

test('a measure-less gold still scaffolds a count cube (so the view is valid)', () => {
  const y = scaffoldCubeYaml(gold({ measures: [] }));
  assert.match(y, /name: count\n\s+type: count/);
});

test('the richer Cube measure fields emit only when present (plain measures unchanged)', () => {
  const y = scaffoldCubeYaml(gold({
    measures: [{
      name: 'completed_revenue', type: 'sum', sql: 'net_amount',
      filters: [{ sql: "{CUBE}.status = 'completed'" }],
      rollingWindow: { trailing: '7 day', offset: 'end' },
      format: 'currency',
      drillMembers: ['order_id', 'region'],
    }],
  }));
  assert.match(y, /filters:\n\s+- sql: "\{CUBE\}\.status = 'completed'"/);
  assert.match(y, /rolling_window:\n\s+trailing: 7 day\n\s+offset: end/);
  assert.match(y, /format: currency/);
  assert.match(y, /drill_members: \[order_id, region\]/);
  // A plain measure alongside it emits NO rich blocks (no leakage).
  const plain = scaffoldCubeYaml(gold());
  assert.doesNotMatch(plain, /filters:|rolling_window:|format:|drill_members:/);
});

test('handover names line up across cube + exposure + dashboard', () => {
  const d = gold();
  assert.equal(goldMartFqn(d), 'iceberg.sales.gold_orders');
  assert.equal(cubeViewName(d), 'Orders');
});
