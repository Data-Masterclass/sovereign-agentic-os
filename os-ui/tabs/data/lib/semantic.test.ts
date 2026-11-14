/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The per-dataset semantic PREVIEW is the same artefact the dbt project carries
 * USER STORY: As a creator looking at my dataset's files I want the YAML shown to be the YAML
 *             committed — one definition of a metric, not two differently-shaped ones (M1, M3).
 * ARCHITECTURE:
 *   - This file used to pin the old string builder's output, including two defects it is worth
 *     naming: `ref('mart_<slug>')` (a model the generated project does not contain, so `dbt parse`
 *     would have failed for the whole domain) and `expr: "{{ metric('x') }}"` for a derived metric
 *     (not a form dbt accepts). Both are now regression assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldSemanticYaml, SEMANTIC_ARTIFACT, datasetModelName } from '@tabs/data/lib/semantic';
import { parseSemanticYaml, emitSemanticYaml } from '@tabs/data/lib/dbt/semantic/model';
import { validateSemanticDoc } from '@tabs/data/lib/dbt/semantic/validate';
import { emptyVersions, type Dataset } from '@tabs/data/lib/dataset-schema';

function gold(over: Partial<Dataset> = {}): Dataset {
  const versions = emptyVersions();
  versions.bronze.built = true;
  versions.silver.built = true;
  versions.gold.built = true;
  return {
    version: '1',
    id: 'ds_orders',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    description: 'Sales orders.',
    versions,
    grants: [],
    measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
    columns: [
      { name: 'order_id', description: 'Key.' },
      { name: 'order_date', description: 'When.' },
      { name: 'region', description: 'Where.' },
      { name: 'net_amount', description: 'Value.' },
    ],
    ...over,
  };
}

test('one semantic_model per dataset, bound to the dataset`s FURTHEST BUILT model by a dbt ref', () => {
  const y = scaffoldSemanticYaml(gold());
  assert.match(y, /^semantic_models:/);
  assert.match(y, /- name: orders\n/);
  assert.equal(datasetModelName(gold()), 'gold_orders');
  assert.match(y, /model: ref\('gold_orders'\)/);
  // The predecessor emitted `ref('mart_orders')` — a model that exists in NO generated project,
  // so `dbt parse` would have failed for the entire domain the moment the file reached it.
  assert.doesNotMatch(y, /mart_orders/);
});

test('dimensions, entities and measures are the dbt shapes, and the document is spec-valid', () => {
  const y = scaffoldSemanticYaml(gold());
  const doc = parseSemanticYaml(y);
  assert.deepEqual(validateSemanticDoc(doc), []);
  assert.deepEqual(doc.semantic_models[0].entities, [{ name: 'orders', type: 'primary', expr: 'order_id' }]);
  const dims = new Map(doc.semantic_models[0].dimensions.map((d) => [d.name, d]));
  assert.equal(dims.get('order_date')!.type, 'time');
  assert.deepEqual(dims.get('order_date')!.type_params, { time_granularity: 'day' });
  assert.equal(dims.get('region')!.type, 'categorical');
  assert.equal(dims.has('order_id'), false, 'the primary key is not a dimension');
  assert.deepEqual(doc.semantic_models[0].measures, [{ name: 'revenue', agg: 'sum', description: undefined, expr: 'net_amount' }].map((m) => {
    const { description: _drop, ...rest } = m;
    return rest;
  }));
  assert.equal(doc.metrics[0].type, 'simple');
});

test('the preview round-trips and is byte-stable', () => {
  const a = scaffoldSemanticYaml(gold());
  assert.equal(scaffoldSemanticYaml(gold()), a);
  assert.equal(emitSemanticYaml(parseSemanticYaml(a)), a);
});

test('a derived metric references its inputs BY NAME, never as `{{ metric(...) }}`', () => {
  const y = scaffoldSemanticYaml(
    gold({
      measures: [
        { name: 'revenue', type: 'sum', sql: 'net_amount' },
        { name: 'orders', type: 'count', sql: '' },
        { name: 'margin', type: 'number', sql: '{revenue} - {orders}', formula: '[revenue]-[orders]' },
      ],
    }),
  );
  assert.match(y, /type: derived/);
  assert.match(y, /expr: revenue - orders/);
  assert.doesNotMatch(y, /\{\{ metric\(/, 'the predecessor emitted a form dbt does not accept here');
});

test('a dataset with no emittable metric previews as the empty string (no file is written)', () => {
  assert.equal(scaffoldSemanticYaml(gold({ measures: [] })), '');
});

test('the artifact path keeps the cube artifact`s namespacing scheme', () => {
  assert.equal(SEMANTIC_ARTIFACT(gold()), 'semantic/orders.yml');
  assert.equal(SEMANTIC_ARTIFACT(gold({ viewNamespaced: true })), 'semantic/sales__orders.yml');
});
