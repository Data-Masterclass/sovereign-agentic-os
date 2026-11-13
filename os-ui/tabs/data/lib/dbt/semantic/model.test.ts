/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Round-trip and spec-validity of the typed dbt semantic document
 * USER STORY: As a maintainer I want proof that `parse(emit(x)) === x` for every metric type and
 *             that the emitted YAML validates against the pinned spec, so a hand-edited file in a
 *             domain repo comes back as the same model and `dbt parse` never sees an unknown key
 *             (checklist M2, M3, M4).
 * ARCHITECTURE:
 *   - Pure: literal documents, no store, no cluster. One fixture per metric type.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { emitSemanticYaml, parseSemanticYaml, type SemanticDoc } from '@tabs/data/lib/dbt/semantic/model';
import { validateSemanticDoc, isSafeSemanticFilter } from '@tabs/data/lib/dbt/semantic/validate';
import { ALLOWED_KEYS, DBT_SEMANTIC_SPEC, METRIC_TIME_WINDOW_RE } from '@tabs/data/lib/dbt/semantic/spec';

function base(): SemanticDoc {
  return {
    semantic_models: [
      {
        name: 'orders',
        description: 'Web-shop orders.',
        model: "ref('gold_orders')",
        defaults: { agg_time_dimension: 'order_month' },
        entities: [{ name: 'orders', type: 'primary', expr: 'order_id' }],
        dimensions: [
          { name: 'order_month', type: 'time', type_params: { time_granularity: 'day' }, expr: 'order_month' },
          { name: 'region', type: 'categorical', expr: 'region' },
        ],
        measures: [
          { name: 'net_amount', agg: 'sum', expr: 'net_amount' },
          { name: 'order_count', agg: 'count' },
          { name: 'converted', agg: 'count', config: { meta: { os_agg: 'count' } } },
        ],
      },
    ],
    metrics: [],
  };
}

const SHAPES: Record<string, () => SemanticDoc> = {
  simple: () => {
    const d = base();
    d.metrics = [
      { name: 'revenue', type: 'simple', type_params: { measure: { name: 'net_amount' } }, label: 'Revenue', config: { meta: { os_metric: 'ds_1.revenue' } } },
      { name: 'orders', type: 'simple', type_params: { measure: { name: 'order_count' } } },
      { name: 'converted', type: 'simple', type_params: { measure: { name: 'converted' } } },
    ];
    return d;
  },
  'simple-filtered': () => {
    const d = base();
    d.metrics = [
      {
        name: 'revenue_eu',
        type: 'simple',
        type_params: { measure: { name: 'net_amount' } },
        filter: "{{ Dimension('orders__region') }} = 'eu'",
      },
    ];
    return d;
  },
  ratio: () => {
    const d = base();
    d.metrics = [
      { name: 'revenue', type: 'simple', type_params: { measure: { name: 'net_amount' } } },
      { name: 'orders', type: 'simple', type_params: { measure: { name: 'order_count' } } },
      {
        name: 'conversion_rate',
        type: 'ratio',
        type_params: {
          // Each side carries its OWN filter — the shape a `number` measure cannot express (M-R2.2).
          numerator: { name: 'revenue', filter: "{{ Dimension('orders__region') }} = 'eu'", alias: 'eu_revenue' },
          denominator: { name: 'orders' },
        },
      },
    ];
    return d;
  },
  derived: () => {
    const d = base();
    d.metrics = [
      { name: 'revenue', type: 'simple', type_params: { measure: { name: 'net_amount' } } },
      { name: 'orders', type: 'simple', type_params: { measure: { name: 'order_count' } } },
      {
        name: 'revenue_per_order',
        type: 'derived',
        type_params: { expr: 'revenue / orders', metrics: [{ name: 'revenue' }, { name: 'orders' }] },
      },
      {
        name: 'revenue_mom',
        type: 'derived',
        type_params: {
          expr: '(revenue - revenue_prev) * 100 / revenue_prev',
          metrics: [{ name: 'revenue' }, { name: 'revenue', alias: 'revenue_prev', offset_window: '1 month' }],
        },
      },
    ];
    return d;
  },
  cumulative: () => {
    const d = base();
    d.metrics = [
      {
        name: 'revenue_t7d',
        type: 'cumulative',
        type_params: { measure: { name: 'net_amount' }, cumulative_type_params: { window: '7 day' } },
      },
      {
        name: 'revenue_mtd',
        type: 'cumulative',
        type_params: { measure: { name: 'net_amount' }, cumulative_type_params: { grain_to_date: 'month' } },
      },
      { name: 'revenue_all_time', type: 'cumulative', type_params: { measure: { name: 'net_amount' } } },
    ];
    return d;
  },
};

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`round-trip: ${shape} — parse(emit(x)) deep-equals x`, () => {
    const doc = make();
    const text = emitSemanticYaml(doc);
    assert.deepEqual(parseSemanticYaml(text), doc, `${shape} did not round-trip:\n${text}`);
  });

  test(`byte-stable: ${shape} emitted twice is identical and parses as YAML`, () => {
    const a = emitSemanticYaml(make());
    const b = emitSemanticYaml(make());
    assert.equal(a, b);
    yaml.load(a);
    assert.ok(a.endsWith('\n') && !a.endsWith('\n\n'));
  });

  test(`spec-valid: ${shape} has no violation against DSI ${DBT_SEMANTIC_SPEC.dsiVersion}`, () => {
    assert.deepEqual(validateSemanticDoc(make()), []);
  });
}

test('the short scalar form is emitted for a name-only input and lifts back to an object', () => {
  const text = emitSemanticYaml(SHAPES.simple());
  assert.match(text, /measure: net_amount/, 'a name-only measure input is the short scalar form');
  assert.doesNotMatch(text, /measure:\n\s+name: net_amount/);
  assert.deepEqual(parseSemanticYaml(text).metrics[0].type_params.measure, { name: 'net_amount' });
});

test('a ratio side with a filter is emitted as an OBJECT, not a scalar', () => {
  const text = emitSemanticYaml(SHAPES.ratio());
  assert.match(text, /numerator:\n\s+name: revenue\n\s+filter:/);
  assert.match(text, /denominator: orders/);
});

test('authored prose is made inert — dbt renders YAML through Jinja before reading it', () => {
  const d = base();
  d.semantic_models[0].description = "{{ env_var('AGENT_RUNTIME_TOKEN') }} and {% raw %}x{% endraw %}";
  d.metrics = [{ name: 'revenue', type: 'simple', type_params: { measure: { name: 'net_amount' } }, description: '{{ 1+1 }}' }];
  const text = emitSemanticYaml(d);
  assert.doesNotMatch(text, /\{\{|\}\}|\{%|%\}/, 'no Jinja delimiter survives in prose');
});

test('a filter OUTSIDE the closed grammar is a violation (an injected value can never become a template)', () => {
  assert.ok(isSafeSemanticFilter("{{ Dimension('orders__region') }} = 'eu'"));
  assert.ok(isSafeSemanticFilter("{{ TimeDimension('orders__order_month', 'month') }} >= '2024-01-01'"));
  assert.ok(isSafeSemanticFilter("{{ Dimension('orders__region') }} IS NOT NULL"));
  assert.ok(isSafeSemanticFilter("{{ Dimension('orders__region') }} = 'eu' AND {{ Dimension('orders__region') }} <> 'us'"));
  for (const bad of [
    "{{ Dimension('orders__region') }} = '{{ env_var(\\'X\\') }}'",
    "region = 'eu'",
    "{{ Dimension('orders__region') }} = 'eu' OR 1=1",
    "{{ Metric('ltv', group_by=['customer']) }} > 100",
    "{{ Dimension('orders__region') }} in ('eu')",
  ]) {
    assert.equal(isSafeSemanticFilter(bad), false, `should be refused: ${bad}`);
  }
  const d = base();
  d.metrics = [{ name: 'revenue', type: 'simple', type_params: { measure: { name: 'net_amount' } }, filter: "region = 'eu'" }];
  assert.match(validateSemanticDoc(d).join('\n'), /closed filter grammar/);
});

test('the validator refuses what fails dbt parse: unknown enum, missing grain, duplicate name, unresolved input', () => {
  const unknownAgg = base();
  unknownAgg.semantic_models[0].measures[0] = { name: 'x', agg: 'count_distinct_approx' as never, expr: 'a' };
  assert.match(validateSemanticDoc(unknownAgg).join('\n'), /is not one of the nine DSI AggregationTypes/);

  const noGrain = base();
  delete noGrain.semantic_models[0].dimensions[0].type_params;
  assert.match(validateSemanticDoc(noGrain).join('\n'), /needs type_params\.time_granularity/);

  const dupMetric = base();
  dupMetric.metrics = [
    { name: 'revenue', type: 'simple', type_params: { measure: { name: 'net_amount' } } },
    { name: 'revenue', type: 'simple', type_params: { measure: { name: 'order_count' } } },
  ];
  assert.match(validateSemanticDoc(dupMetric).join('\n'), /duplicate metric name/);

  const unresolved = base();
  unresolved.metrics = [{ name: 'rpo', type: 'derived', type_params: { expr: 'a / b', metrics: [{ name: 'a' }, { name: 'b' }] } }];
  assert.match(validateSemanticDoc(unresolved).join('\n'), /input metric 'a' is not declared/);

  const badModelRef = base();
  badModelRef.semantic_models[0].model = 'gold_orders';
  badModelRef.metrics = SHAPES.simple().metrics;
  assert.match(validateSemanticDoc(badModelRef).join('\n'), /expected ref\('<model>'\)/);

  const badWindow = base();
  badWindow.metrics = [{ name: 'r', type: 'cumulative', type_params: { measure: { name: 'net_amount' }, cumulative_type_params: { window: 'last 7 days' } } }];
  assert.match(validateSemanticDoc(badWindow).join('\n'), /is not "<count> <granularity>"/);

  const bothWindow = base();
  bothWindow.metrics = [
    { name: 'r', type: 'cumulative', type_params: { measure: { name: 'net_amount' }, cumulative_type_params: { window: '7 day', grain_to_date: 'month' } } },
  ];
  assert.match(validateSemanticDoc(bothWindow).join('\n'), /mutually exclusive/);
});

test('the pinned spec version is one constant, and the key whitelists carry no field the floor lacks', () => {
  assert.equal(DBT_SEMANTIC_SPEC.dsiVersion, '0.8.5');
  assert.equal(DBT_SEMANTIC_SPEC.dbtCore, '1.10');
  // `cumulative_type_params` does NOT exist in DSI 0.5.x (dbt 1.8); the floor must therefore be
  // >= 1.9, and the OS images' pin must allow it. If the images move, this is the tripwire.
  assert.equal(DBT_SEMANTIC_SPEC.minDbtCore, '1.9');
  assert.equal(DBT_SEMANTIC_SPEC.imagePin, 'dbt-core>=1.8,<1.10');
  assert.ok(ALLOWED_KEYS.metricTypeParams.includes('cumulative_type_params'));
  // 1.12 ("Fusion") renames these; none of the 1.12-only spellings may leak into the whitelist.
  for (const list of Object.values(ALLOWED_KEYS)) {
    assert.ok(!(list as readonly string[]).includes('input_metrics'), 'input_metrics is dbt 1.12 only');
  }
  assert.equal(DBT_SEMANTIC_SPEC.timeSpineProperty, 'time_spine');
  assert.ok(METRIC_TIME_WINDOW_RE.test('28 days'));
  assert.ok(METRIC_TIME_WINDOW_RE.test('7 day'));
  assert.equal(METRIC_TIME_WINDOW_RE.test('7 fortnights'), false);
});

test('an empty document emits nothing (no file is written for a dataset with no metric)', () => {
  assert.equal(emitSemanticYaml({ semantic_models: [], metrics: [] }), '');
});
