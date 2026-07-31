/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldSemanticYaml, SEMANTIC_ARTIFACT } from './semantic.ts';
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

test('MetricFlow semantic: one semantic_model bound to the gold mart via a dbt ref', () => {
  const y = scaffoldSemanticYaml(gold());
  assert.match(y, /^semantic_models:/);
  assert.match(y, /- name: orders\n/);
  assert.match(y, /model: ref\('mart_orders'\)/);
});

test('MetricFlow semantic: the primary key is a primary ENTITY', () => {
  const y = scaffoldSemanticYaml(gold());
  assert.match(y, /entities:\n\s+- name: order_id\n\s+type: primary\n\s+expr: order_id/);
});

test('MetricFlow semantic: dimensions come from gold columns; time cols get a day grain', () => {
  const y = scaffoldSemanticYaml(gold());
  // order_date is a TIME dimension (inferDimType) with a day granularity…
  assert.match(y, /- name: order_date\n\s+type: time\n\s+expr: order_date\n\s+type_params:\n\s+time_granularity: day/);
  // …region is categorical.
  assert.match(y, /- name: region\n\s+type: categorical\n\s+expr: region/);
  // the PK is an entity, NOT a dimension (no dimension block for order_id)
  assert.doesNotMatch(y, /- name: order_id\n\s+type: (categorical|time)/);
  // net_amount is the measure's SOURCE column (not the measure name) — it stays a
  // categorical dimension (MetricFlow dims are time or categorical, never numeric).
  assert.match(y, /- name: net_amount\n\s+type: categorical\n\s+expr: net_amount/);
});

test('MetricFlow semantic: an aggregate measure yields a measure block + a simple metric', () => {
  const y = scaffoldSemanticYaml(gold());
  assert.match(y, /measures:\n\s+- name: revenue\n\s+agg: sum\n\s+expr: net_amount/);
  assert.match(y, /metrics:/);
  assert.match(y, /- name: revenue\n\s+type: simple\n\s+type_params:\n\s+measure: revenue/);
});

test('MetricFlow semantic: count needs no expr (COUNT(*))', () => {
  const y = scaffoldSemanticYaml(gold({ measures: [{ name: 'orders', type: 'count', sql: '' }] }));
  assert.match(y, /- name: orders\n\s+agg: count\n/);
  assert.doesNotMatch(y, /agg: count\n\s+expr:/);
});

test('MetricFlow semantic: avg maps to average, count_distinct is preserved', () => {
  const y = scaffoldSemanticYaml(gold({
    measures: [
      { name: 'aov', type: 'avg', sql: 'net_amount' },
      { name: 'buyers', type: 'count_distinct', sql: 'customer_id' },
    ],
  }));
  assert.match(y, /- name: aov\n\s+agg: average\n\s+expr: net_amount/);
  assert.match(y, /- name: buyers\n\s+agg: count_distinct\n\s+expr: customer_id/);
});

test('MetricFlow semantic: a ratio becomes a DERIVED metric over sibling metrics', () => {
  const y = scaffoldSemanticYaml(gold({
    measures: [
      { name: 'revenue', type: 'sum', sql: 'net_amount' },
      { name: 'orders', type: 'count', sql: '' },
      { name: 'avg_order', type: 'number', sql: '1.0 * {revenue} / {orders}' },
    ],
  }));
  assert.match(y, /- name: avg_order\n\s+type: derived\n\s+type_params:\n\s+expr: "1\.0 \* \{\{ metric\('revenue'\) \}\} \/ \{\{ metric\('orders'\) \}\}"/);
});

test('MetricFlow semantic: a rolling-window measure emits NO metric (Phase 2, honest)', () => {
  const y = scaffoldSemanticYaml(gold({
    measures: [{ name: 'r7', type: 'sum', sql: 'net_amount', rollingWindow: { trailing: '7 day' } }],
  }));
  // no simple measure/metric for the window shape — it has no portable MetricFlow form yet.
  assert.doesNotMatch(y, /- name: r7/);
});

test('MetricFlow semantic: a ratio over an UNKNOWN base measure emits no derived metric', () => {
  const y = scaffoldSemanticYaml(gold({
    measures: [
      { name: 'orders', type: 'count', sql: '' },
      { name: 'bad', type: 'number', sql: '{nope} / {orders}' },
    ],
  }));
  assert.doesNotMatch(y, /- name: bad/);
});

test('MetricFlow semantic: join-aware — dimensions follow goldOutputColumns, not base docs', () => {
  const d = gold({
    goldSpec: {
      joins: [{ datasetId: 'ds_products', type: 'inner', baseCol: 'product_id', joinCol: 'product_id' }],
      dimensions: [
        { source: '0::order_id' },
        { source: '0::net_amount', as: 'net' },
        { source: '1::product_name' },
      ],
      measures: [],
    },
  });
  const y = scaffoldSemanticYaml(d);
  assert.match(y, /- name: product_name/); // the joined column is a dimension
  assert.match(y, /- name: net\n/); // the renamed column
  assert.doesNotMatch(y, /- name: region/); // an unprojected base column is NOT a dimension
});

test('the semantic artifact path namespaces like the cube artifact', () => {
  assert.equal(SEMANTIC_ARTIFACT(gold()), 'semantic/orders.yml');
  assert.equal(SEMANTIC_ARTIFACT(gold({ cubeNamespaced: true })), 'semantic/sales__orders.yml');
});
