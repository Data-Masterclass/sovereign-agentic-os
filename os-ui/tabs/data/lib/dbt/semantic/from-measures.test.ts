/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OS `Measure` → dbt semantic document: the type map, the refusals, the name space
 * USER STORY: As a maintainer I want each OS aggregation to land on the right dbt `agg`, each
 *             ratio as `type: ratio` (never a `number` measure carrying division SQL), and anything
 *             with no faithful dbt form to be a NAMED refusal rather than wrong YAML (M5, M6).
 * ARCHITECTURE:
 *   - Pure: literal `Dataset` fixtures, no store, no cluster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Dataset, Measure } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { dbtFilterFor, entityNameFor, semanticDocFor, semanticNames } from '@tabs/data/lib/dbt/semantic/from-measures';
import { validateSemanticDoc } from '@tabs/data/lib/dbt/semantic/validate';

const built = { built: true, passThrough: false, quality: 'unknown' as const, updatedAt: '2026-11-14T00:00:00.000Z', artifact: 'gold/mart.sql' };

function ds(measures: Measure[], extra: Partial<Dataset> = {}): Dataset {
  return {
    version: '1',
    id: 'ds_orders1',
    name: 'Orders',
    owner: 'amir',
    domain: 'sales',
    tier: 'asset',
    visibility: 'domain',
    folder: '/',
    description: 'Web-shop orders.',
    versions: { ...emptyVersions(), gold: built },
    grants: [],
    measures,
    columns: [
      { name: 'order_id', description: 'Order key' },
      { name: 'order_date', description: 'Order date' },
      { name: 'region', description: 'Region' },
      { name: 'net_amount', description: 'Net amount' },
    ],
    viewNamespaced: false,
    ...extra,
  } as Dataset;
}

function build(measures: Measure[], extra: Partial<Dataset> = {}) {
  return semanticDocFor({ dataset: ds(measures, extra), model: 'gold_orders' });
}

export {}; // the file is a module; the helpers above are shared by the review-round cases below.

test('a simple metric is `type: simple` over a measure with the right dbt agg and an expr', () => {
  const { doc, refusals } = build([{ name: 'revenue', type: 'sum', sql: 'net_amount', label: 'Revenue' }]);
  assert.deepEqual(refusals, []);
  assert.deepEqual(doc.semantic_models[0].measures, [{ name: 'revenue', agg: 'sum', expr: 'net_amount', label: 'Revenue' }]);
  assert.equal(doc.semantic_models[0].model, "ref('gold_orders')");
  assert.equal(doc.metrics[0].type, 'simple');
  assert.deepEqual(doc.metrics[0].type_params.measure, { name: 'revenue' });
  assert.equal(doc.metrics[0].config?.meta?.os_metric, 'ds_orders1.revenue');
  assert.deepEqual(validateSemanticDoc(doc), []);
});

test('each OS aggregation maps to its DSI agg; `count` carries no expr', () => {
  const { doc, refusals } = build([
    { name: 'orders', type: 'count', sql: '' },
    { name: 'customers', type: 'count_distinct', sql: 'customer_id' },
    { name: 'amount_sum', type: 'sum', sql: 'net_amount' },
    { name: 'amount_avg', type: 'avg', sql: 'net_amount' },
    { name: 'amount_min', type: 'min', sql: 'net_amount' },
    { name: 'amount_max', type: 'max', sql: 'net_amount' },
  ]);
  assert.deepEqual(refusals, []);
  const byName = new Map(doc.semantic_models[0].measures.map((m) => [m.name, m]));
  assert.equal(byName.get('orders')!.agg, 'count');
  assert.equal(byName.get('orders')!.expr, undefined);
  assert.equal(byName.get('customers')!.agg, 'count_distinct');
  assert.equal(byName.get('amount_sum')!.agg, 'sum');
  assert.equal(byName.get('amount_avg')!.agg, 'average', 'OS avg → DSI average');
  assert.equal(byName.get('amount_min')!.agg, 'min');
  assert.equal(byName.get('amount_max')!.agg, 'max');
});

test('count_distinct_approx has no dbt agg: it emits count_distinct + config.meta.os_agg (D6)', () => {
  const { doc, refusals } = build([{ name: 'visitors', type: 'count_distinct_approx', sql: 'visitor_id' }]);
  assert.deepEqual(refusals, []);
  assert.equal(doc.semantic_models[0].measures[0].agg, 'count_distinct');
  assert.deepEqual(doc.semantic_models[0].measures[0].config, { meta: { os_agg: 'count_distinct_approx' } });
  assert.equal(doc.metrics[0].config?.meta?.os_agg, 'count_distinct_approx');
  assert.deepEqual(validateSemanticDoc(doc), []);
});

test('a ratio is `type: ratio` with numerator/denominator — NOT a number measure carrying `1.0 * {a} / {b}`', () => {
  const { doc, refusals } = build([
    { name: 'revenue', type: 'sum', sql: 'net_amount' },
    { name: 'orders', type: 'count', sql: '' },
    { name: 'aov', type: 'number', sql: '1.0 * {revenue} / {orders}' },
  ]);
  assert.deepEqual(refusals, []);
  const aov = doc.metrics.find((m) => m.name === 'aov')!;
  assert.equal(aov.type, 'ratio');
  assert.deepEqual(aov.type_params.numerator, { name: 'revenue' });
  assert.deepEqual(aov.type_params.denominator, { name: 'orders' });
  assert.equal(aov.type_params.expr, undefined, 'no SQL expression on a ratio');
  assert.deepEqual(validateSemanticDoc(doc), []);
});

test('a composite formula is `type: derived` with expr + metrics, referencing input metrics BY NAME', () => {
  const { doc, refusals } = build([
    { name: 'revenue', type: 'sum', sql: 'net_amount' },
    { name: 'cost', type: 'sum', sql: 'cost_amount' },
    { name: 'orders', type: 'count', sql: '' },
    { name: 'margin_per_order', type: 'number', sql: '({revenue} - {cost}) / {orders}', formula: '([revenue]-[cost])/[orders]' },
  ]);
  assert.deepEqual(refusals, []);
  const m = doc.metrics.find((x) => x.name === 'margin_per_order')!;
  assert.equal(m.type, 'derived');
  assert.equal(m.type_params.expr, '(revenue - cost) / orders');
  assert.doesNotMatch(m.type_params.expr!, /\{\{ metric\(/, "the predecessor's `{{ metric('x') }}` form is not what dbt accepts here");
  assert.deepEqual(m.type_params.metrics, [{ name: 'cost' }, { name: 'orders' }, { name: 'revenue' }]);
  assert.deepEqual(validateSemanticDoc(doc), []);
});

test('a trailing window is `type: cumulative` with cumulative_type_params.window; unbounded is all-time', () => {
  const { doc, refusals } = build([
    { name: 'revenue_t7d', type: 'sum', sql: 'net_amount', rollingWindow: { trailing: '7 day', offset: 'end' } },
    { name: 'revenue_rt', type: 'sum', sql: 'net_amount', rollingWindow: { trailing: 'unbounded' } },
  ]);
  assert.deepEqual(refusals, []);
  const t7 = doc.metrics.find((m) => m.name === 'revenue_t7d')!;
  assert.equal(t7.type, 'cumulative');
  assert.deepEqual(t7.type_params.cumulative_type_params, { window: '7 day' });
  const rt = doc.metrics.find((m) => m.name === 'revenue_rt')!;
  assert.equal(rt.type, 'cumulative');
  assert.equal(rt.type_params.cumulative_type_params, undefined, 'all-time cumulative carries neither window nor grain_to_date');
  assert.deepEqual(validateSemanticDoc(doc), []);
});

test('a guided measure filter becomes the dbt filter syntax on the metric', () => {
  const { doc, refusals } = build([
    { name: 'revenue_eu', type: 'sum', sql: 'net_amount', filters: [{ sql: "{CUBE}.region = 'eu'" }] },
  ]);
  assert.deepEqual(refusals, []);
  assert.equal(doc.metrics[0].filter, "{{ Dimension('orders__region') }} = 'eu'");
  assert.deepEqual(validateSemanticDoc(doc), []);
});

test('a filter on a TIME dimension uses TimeDimension, and the entity prefix is the dataset slug', () => {
  assert.equal(entityNameFor(ds([])), 'orders');
  assert.equal(
    dbtFilterFor(["{CUBE}.order_date >= '2024-01-01'"], 'orders', new Set(['order_date'])),
    "{{ TimeDimension('orders__order_date', 'day') }} >= '2024-01-01'",
  );
  assert.equal(dbtFilterFor(['{CUBE}.region IS NOT NULL'], 'orders', new Set()), "{{ Dimension('orders__region') }} IS NOT NULL");
  assert.equal(dbtFilterFor(['{CUBE}.region IS NULL'], 'orders', new Set()), "{{ Dimension('orders__region') }} IS NULL");
  // Not one of the OS's generated shapes → null, so the whole metric is refused.
  assert.equal(dbtFilterFor(["region = 'eu'"], 'orders', new Set()), null);
  assert.equal(dbtFilterFor(["{CUBE}.region = '{{ env_var(''X'') }}'"], 'orders', new Set()), null);
});

const REFUSED: [string, Measure[], RegExp][] = [
  ['a leading window', [{ name: 'f', type: 'sum', sql: 'net_amount', rollingWindow: { leading: '7 day' } }], /leading window has no dbt metric form/],
  ['an unparseable trailing window', [{ name: 'f', type: 'sum', sql: 'net_amount', rollingWindow: { trailing: 'last week' } }], /is not dbt's "<count> <granularity>" form/],
  ['a sum with no column', [{ name: 'f', type: 'sum', sql: '' }], /needs a column expression/],
  ['an unknown aggregation', [{ name: 'f', type: 'p99', sql: 'net_amount' }], /has no dbt AggregationType/],
  ['a ratio with no refs', [{ name: 'f', type: 'number', sql: '1.0' }], /references no other metric/],
  [
    'a formula over a metric that is not emitted',
    [{ name: 'f', type: 'number', sql: '{ghost} / 2' }],
    /references metric\(s\) not emitted in this document: ghost/,
  ],
  [
    "a ratio carrying its OWN filter (the OS compiler drops it)",
    [
      { name: 'revenue', type: 'sum', sql: 'net_amount' },
      { name: 'orders', type: 'count', sql: '' },
      { name: 'r', type: 'number', sql: '1.0 * {revenue} / {orders}', filters: [{ sql: "{CUBE}.region = 'eu'" }] },
    ],
    /does not apply a ratio's own filter/,
  ],
  [
    'a measure filter outside the guided shapes',
    [{ name: 'f', type: 'sum', sql: 'net_amount', filters: [{ sql: 'net_amount > (select max(x) from t)' }] }],
    /no safe dbt filter form/,
  ],
];

for (const [what, measures, reason] of REFUSED) {
  test(`REFUSED, not guessed: ${what}`, () => {
    const { doc, refusals } = build(measures);
    assert.ok(refusals.length >= 1, 'expected a refusal');
    assert.match(refusals.map((r) => r.reason).join('\n'), reason);
    assert.equal(doc.metrics.some((m) => m.name === 'f' || m.name === 'r'), false, 'nothing is emitted for a refused metric');
    assert.deepEqual(validateSemanticDoc(doc), [], 'what IS emitted stays spec-valid');
  });
}

test('names are project-global: a second dataset reusing `revenue` is qualified, and the OS id never moves', () => {
  const alloc = semanticNames();
  const a = semanticDocFor({ dataset: ds([{ name: 'revenue', type: 'sum', sql: 'net_amount' }]), model: 'gold_orders' }, alloc);
  const b = semanticDocFor(
    { dataset: ds([{ name: 'revenue', type: 'sum', sql: 'net_amount' }], { id: 'ds_sub00001', name: 'Subs' }), model: 'gold_subs' },
    alloc,
  );
  assert.equal(a.doc.metrics[0].name, 'revenue');
  assert.equal(b.doc.metrics[0].name, 'subs__revenue', 'a collision is qualified with the semantic model name');
  assert.equal(b.doc.metrics[0].config?.meta?.os_metric, 'ds_sub00001.revenue', 'the OS metric id is unchanged');
  assert.equal(b.doc.semantic_models[0].measures[0].name, 'subs__revenue');
  assert.deepEqual(b.doc.metrics[0].type_params.measure, { name: 'subs__revenue' });
});

test('a measure and its metric may share a name (the canonical dbt shape) — separate namespaces', () => {
  const { doc } = build([{ name: 'revenue', type: 'sum', sql: 'net_amount' }]);
  assert.equal(doc.semantic_models[0].measures[0].name, 'revenue');
  assert.equal(doc.metrics[0].name, 'revenue');
});

test('a time dimension gives the model its agg_time_dimension default; dimensions exclude the pk and measure names', () => {
  const { doc } = build([{ name: 'revenue', type: 'sum', sql: 'net_amount' }]);
  const sm = doc.semantic_models[0];
  assert.deepEqual(sm.defaults, { agg_time_dimension: 'order_date' });
  assert.deepEqual(sm.entities, [{ name: 'orders', type: 'primary', expr: 'order_id' }]);
  assert.deepEqual(
    sm.dimensions.map((d) => d.name),
    ['order_date', 'region'],
    'the pk (order_id) is excluded, and so is the numeric fact column net_amount (review L-1)',
  );
  assert.equal(sm.dimensions.find((d) => d.name === 'order_date')!.type, 'time');
  assert.deepEqual(sm.dimensions.find((d) => d.name === 'order_date')!.type_params, { time_granularity: 'day' });
});

test('a dataset with no measure yields no metric, so no file is written for it', () => {
  const { doc, refusals } = build([]);
  assert.deepEqual(doc.metrics, []);
  assert.deepEqual(refusals, []);
});

// ------------------------------------------------- the review round (H-1, M-3, L-1) ---

test('REVIEW H-1: a dataset with measures and NO time column emits nothing, refusing each by name', () => {
  const noDate = [
    { name: 'order_id', description: 'Key' },
    { name: 'region', description: 'Region' },
    { name: 'net_amount', description: 'Amount' },
  ];
  const { doc, refusals } = build(
    [
      { name: 'revenue', type: 'sum', sql: 'net_amount' },
      { name: 'orders', type: 'count', sql: '' },
    ],
    { columns: noDate },
  );
  // dbt requires an agg_time_dimension for EVERY measure. With no time column there is neither a
  // measure-level one nor a model default, so the YAML that used to be emitted failed validation
  // for the whole domain's `dbt parse`.
  assert.deepEqual(doc, { semantic_models: [], metrics: [] });
  assert.deepEqual(
    refusals.map((r) => r.measure),
    ['orders', 'revenue'],
  );
  for (const r of refusals) {
    assert.match(r.reason, /no time dimension/);
    assert.match(r.reason, /agg_time_dimension/);
    assert.match(r.reason, /document a date\/timestamp column/, 'the reason must be actionable');
  }
});

test('REVIEW H-1: the validator refuses a measure with no agg_time_dimension and no model default', () => {
  const { doc } = build([{ name: 'revenue', type: 'sum', sql: 'net_amount' }]);
  assert.deepEqual(validateSemanticDoc(doc), [], 'the happy path still validates');
  // Strip the default the emitter set: this is the document shape the bug produced.
  const stripped = structuredClone(doc);
  delete stripped.semantic_models[0].defaults;
  assert.match(validateSemanticDoc(stripped).join('\n'), /no agg_time_dimension, and the semantic model declares no defaults\.agg_time_dimension/);
});

test('REVIEW M-3: a THIRD collision on a non-identifier name still yields a dbt identifier', () => {
  const alloc = semanticNames();
  const names = ['a', 'b', 'c'].map((suffix) =>
    semanticDocFor(
      { dataset: ds([{ name: 'Revenue %', type: 'sum', sql: 'net_amount' }], { id: `ds_${suffix}`, name: `D${suffix}` }), model: `gold_d${suffix}` },
      alloc,
    ),
  );
  const emitted = names.flatMap((n) => n.doc.metrics.map((m) => m.name));
  assert.equal(emitted.length, 3);
  for (const n of emitted) {
    assert.match(n, /^[a-z_][a-z0-9_]*$/, `'${n}' must be a dbt identifier — the numbered fallback used to rebuild from the raw name`);
    assert.doesNotMatch(n, /%|\s/);
  }
  assert.equal(new Set(emitted).size, 3, 'and all three must be distinct');
});

test('REVIEW L-1: a numeric fact column is NOT offered as a categorical dimension; a key-shaped one is', () => {
  const { doc } = build([{ name: 'revenue', type: 'sum', sql: 'net_amount' }], {
    columns: [
      { name: 'order_id', description: 'Key' },
      { name: 'order_date', description: 'Date' },
      { name: 'region', description: 'Region' },
      { name: 'net_amount', description: 'Amount' },
      { name: 'quantity', description: 'Units' },
      { name: 'customer_id', description: 'Customer key' },
    ],
  });
  const dims = doc.semantic_models[0].dimensions.map((d) => d.name);
  assert.deepEqual(dims, ['customer_id', 'order_date', 'region']);
  assert.equal(dims.includes('net_amount'), false, 'grouping by an amount yields one row per amount');
  assert.equal(dims.includes('quantity'), false);
  assert.deepEqual(validateSemanticDoc(doc), []);
});
