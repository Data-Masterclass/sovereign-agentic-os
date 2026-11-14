/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The engineer's door reads the metric file the OS wrote — and refuses a bad one
 * USER STORY: As a maintainer I want the file the generator writes to be exactly what the push
 *             ingest reads back (the "coin test" halves agreeing), and a pushed file that would
 *             break the domain's `dbt parse` to be a readable rejection (D28, D29).
 * ARCHITECTURE:
 *   - Pure. Drives the real generator for the OS half, so the two halves cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { generateProject } from '@tabs/data/lib/dbt/generate';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';
import { ingestFromRepo, isSemanticPath } from '@tabs/data/lib/dbt/semantic/ingest';

const built = (artifact: string | null, passThrough = false) => ({
  built: true,
  passThrough,
  quality: 'unknown' as const,
  updatedAt: '2026-11-14T00:00:00.000Z',
  artifact,
});

function orders(extra: Partial<Dataset> = {}): Dataset {
  return {
    version: '1',
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    folder: '/',
    description: 'Orders.',
    versions: { bronze: built('b.yml'), silver: built('s.sql', true), gold: built('g.sql', true) },
    grants: [],
    measures: [
      { name: 'revenue', type: 'sum', sql: 'net_amount', label: 'Revenue' },
      { name: 'orders', type: 'count', sql: '' },
      { name: 'aov', type: 'number', sql: '1.0 * {revenue} / {orders}' },
      { name: 'revenue_eu', type: 'sum', sql: 'net_amount', filters: [{ sql: "{CUBE}.region = 'eu'" }] },
    ],
    columns: [
      { name: 'order_id', description: 'Key' },
      { name: 'order_date', description: 'Date' },
      { name: 'region', description: 'Region' },
      { name: 'net_amount', description: 'Amount' },
    ],
    viewNamespaced: false,
    ...extra,
  } as Dataset;
}

function generated(d: Dataset = orders()): Map<string, string | null> {
  const snap: ProjectSnapshot = { domain: 'sales', datasets: [{ dataset: d, artifacts: {} }], catalogs: {} };
  const files = generateProject('sales', snap);
  return new Map([...files.entries()]);
}

test('the path matcher recognises both lanes and nothing else', () => {
  assert.ok(isSemanticPath('models/semantic/orders.yml'));
  assert.ok(isSemanticPath('models/personal/amir/semantic/orders.yml'));
  for (const no of ['models/gold/gold_orders.sql', 'models/semantic/orders.sql', 'models/gold/schema.yml', 'os/schedules.yml', 'models/semantic/sub/dir/x.yml']) {
    assert.equal(isSemanticPath(no), false, no);
  }
});

test('the push ingest reads back exactly the metrics the generator wrote, with the OS identity intact', () => {
  const { metrics, problems, deleted } = ingestFromRepo('metric', generated());
  assert.deepEqual(problems, []);
  assert.deepEqual(deleted, []);
  assert.deepEqual(
    metrics.map((m) => ({ osMetric: m.osMetric, datasetId: m.datasetId, name: m.name, type: m.type, unlinked: m.unlinked })),
    [
      { osMetric: 'ds_orders1.aov', datasetId: 'ds_orders1', name: 'aov', type: 'ratio', unlinked: false },
      { osMetric: 'ds_orders1.orders', datasetId: 'ds_orders1', name: 'orders', type: 'simple', unlinked: false },
      { osMetric: 'ds_orders1.revenue', datasetId: 'ds_orders1', name: 'revenue', type: 'simple', unlinked: false },
      { osMetric: 'ds_orders1.revenue_eu', datasetId: 'ds_orders1', name: 'revenue_eu', type: 'simple', unlinked: false },
    ],
  );
  const revenue = metrics.find((m) => m.name === 'revenue')!;
  assert.equal(revenue.member, 'Orders.revenue');
  assert.equal(revenue.label, 'Revenue');
  assert.equal(revenue.semanticModel, 'orders');
  assert.equal(revenue.model, 'gold_orders', 'the dbt model name, not the ref() wrapper');
  assert.equal(revenue.path, 'models/semantic/orders.yml');
  assert.equal(metrics.find((m) => m.name === 'revenue_eu')!.filter, "{{ Dimension('orders__region') }} = 'eu'");
});

test('the personal lane is ingested too, and nothing else in the tree is', () => {
  const files = generated(orders({ tier: 'dataset', visibility: 'private' }));
  const { metrics } = ingestFromRepo('metric', files);
  assert.ok(metrics.length >= 1);
  for (const m of metrics) assert.equal(m.path, 'models/personal/amir/semantic/orders.yml');
});

test('a hand-authored metric with no OS identity is reported UNLINKED, never guessed onto a dataset', () => {
  const files = new Map<string, string | null>([
    [
      'models/semantic/handwritten.yml',
      [
        'semantic_models:',
        '  - name: handwritten',
        "    model: ref('gold_orders')",
        '    defaults:',
        '      agg_time_dimension: order_date',
        '    entities:',
        '      - name: handwritten',
        '        type: primary',
        '        expr: order_id',
        '    dimensions:',
        '      - name: order_date',
        '        type: time',
        '        type_params:',
        '          time_granularity: day',
        '    measures:',
        '      - name: hand_revenue',
        '        agg: sum',
        '        expr: net_amount',
        'metrics:',
        '  - name: hand_revenue',
        '    type: simple',
        '    type_params:',
        '      measure: hand_revenue',
        '',
      ].join('\n'),
    ],
  ]);
  const { metrics, problems } = ingestFromRepo('metric', files);
  assert.deepEqual(problems, []);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].unlinked, true);
  assert.equal(metrics[0].osMetric, null);
  assert.equal(metrics[0].datasetId, null);
  assert.equal(metrics[0].name, 'hand_revenue');
});

test('a pushed file that would break `dbt parse` is a PROBLEM naming the file, and nothing from it is ingested', () => {
  const broken = new Map<string, string | null>([
    [
      'models/semantic/bad.yml',
      [
        'semantic_models:',
        '  - name: bad',
        '    model: gold_orders',
        '    entities: []',
        '    dimensions:',
        '      - name: order_date',
        '        type: time',
        '    measures:',
        '      - name: x',
        '        agg: count_distinct_approx',
        '        expr: a',
        'metrics:',
        '  - name: x',
        '    type: simple',
        '    type_params:',
        '      measure: x',
        '',
      ].join('\n'),
    ],
  ]);
  const { metrics, problems } = ingestFromRepo('metric', broken);
  assert.deepEqual(metrics, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, 'models/semantic/bad.yml');
  assert.match(problems[0].reason, /not valid for the pinned dbt semantic spec/);
  assert.match(problems[0].reason, /is not one of the nine DSI AggregationTypes/);
  assert.match(problems[0].reason, /expected ref\('<model>'\)/);
  assert.match(problems[0].reason, /needs type_params\.time_granularity/);
});

test('unparseable YAML is a problem, not a throw — one bad file never fails the whole push reconcile', () => {
  const { metrics, problems } = ingestFromRepo(
    'metric',
    new Map<string, string | null>([
      ['models/semantic/broken.yml', 'semantic_models:\n  - name: [unclosed\n'],
      ['models/semantic/orders.yml', generated().get('models/semantic/orders.yml')!],
    ]),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, 'models/semantic/broken.yml');
  assert.ok(metrics.length >= 1, 'the good file is still ingested');
});

test('a deleted semantic file is returned as deleted, so its rows can be retired', () => {
  const { deleted, metrics } = ingestFromRepo('metric', new Map<string, string | null>([['models/semantic/orders.yml', null]]));
  assert.deepEqual(deleted, ['models/semantic/orders.yml']);
  assert.deepEqual(metrics, []);
});

test('REVIEW L-6: a file with SEVERAL semantic models attributes each metric to the model that declares its measure', () => {
  const two = [
    'semantic_models:',
    '  - name: a',
    "    model: ref('gold_a')",
    '    defaults:',
    '      agg_time_dimension: d',
    '    entities:',
    '      - name: a',
    '        type: primary',
    '        expr: id',
    '    dimensions:',
    '      - name: d',
    '        type: time',
    '        type_params:',
    '          time_granularity: day',
    '    measures:',
    '      - name: m_a',
    '        agg: sum',
    '        expr: amount',
    '  - name: b',
    "    model: ref('gold_b')",
    '    defaults:',
    '      agg_time_dimension: e',
    '    entities:',
    '      - name: b',
    '        type: primary',
    '        expr: id',
    '    dimensions:',
    '      - name: e',
    '        type: time',
    '        type_params:',
    '          time_granularity: day',
    '    measures:',
    '      - name: m_b',
    '        agg: sum',
    '        expr: amount',
    'metrics:',
    '  - name: met_a',
    '    type: simple',
    '    type_params:',
    '      measure: m_a',
    '  - name: met_b',
    '    type: simple',
    '    type_params:',
    '      measure: m_b',
    '',
  ].join('\n');
  const { metrics, problems } = ingestFromRepo('metric', new Map<string, string | null>([['models/semantic/two.yml', two]]));
  assert.deepEqual(problems, []);
  // Reading `semantic_models[0]` only put BOTH metrics on model `a`/`gold_a` — a silently wrong
  // registry row for `met_b`.
  assert.deepEqual(
    metrics.map((m) => [m.name, m.semanticModel, m.model]),
    [
      ['met_a', 'a', 'gold_a'],
      ['met_b', 'b', 'gold_b'],
    ],
  );
});

test('REVIEW L-6: a metric naming no measure in a multi-model file is a PROBLEM, not a guess', () => {
  const ambiguous = [
    'semantic_models:',
    '  - name: a',
    "    model: ref('gold_a')",
    '    defaults: {agg_time_dimension: d}',
    '    entities: [{name: a, type: primary, expr: id}]',
    '    dimensions: [{name: d, type: time, type_params: {time_granularity: day}}]',
    '    measures: [{name: m_a, agg: sum, expr: amount}]',
    '  - name: b',
    "    model: ref('gold_b')",
    '    defaults: {agg_time_dimension: e}',
    '    entities: [{name: b, type: primary, expr: id}]',
    '    dimensions: [{name: e, type: time, type_params: {time_granularity: day}}]',
    '    measures: [{name: m_b, agg: sum, expr: amount}]',
    'metrics:',
    '  - name: met_a',
    '    type: simple',
    '    type_params: {measure: m_a}',
    '  - name: met_b',
    '    type: simple',
    '    type_params: {measure: m_b}',
    '  - name: ratio_ab',
    '    type: ratio',
    '    type_params: {numerator: met_a, denominator: met_b}',
    '',
  ].join('\n');
  const { metrics, problems } = ingestFromRepo('metric', new Map<string, string | null>([['models/semantic/two.yml', ambiguous]]));
  assert.deepEqual(metrics.map((m) => m.name), ['met_a', 'met_b']);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /ratio_ab/);
  assert.match(problems[0].reason, /2 semantic models/);
});

test('REVIEW L-6: a SINGLE-model file still attributes a derived metric to that one model', () => {
  const files = generated();
  const { metrics, problems } = ingestFromRepo('metric', files);
  assert.deepEqual(problems, []);
  const aov = metrics.find((m) => m.name === 'aov')!;
  assert.equal(aov.type, 'ratio');
  assert.equal(aov.semanticModel, 'orders', 'it names no measure, but the file has exactly one model');
});
