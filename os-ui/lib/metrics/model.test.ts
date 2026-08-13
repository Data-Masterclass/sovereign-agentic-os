/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldCubeYaml } from '../data/metrics.ts';
import {
  formFromMeasure,
  measureFromForm,
  measureFromAgent,
  measureFromYaml,
  measureMember,
  sameMeasure,
  type MetricForm,
} from './model.ts';
import { parseDataset } from '../data/dataset-schema.ts';
import { goldSales } from './fixtures.ts';


const REVENUE_FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['order_date', 'region'] };

test('form / agent / YAML all produce the IDENTICAL measure (the same artifact)', () => {
  const d = goldSales();
  const fromForm = measureFromForm(REVENUE_FORM);
  const fromAgent = measureFromAgent({ ...REVENUE_FORM }); // agent returns the same structured proposal
  const fromYaml = measureFromYaml(scaffoldCubeYaml(d), 'Revenue');
  // The activated slice-by dimensions now RIDE ON the measure (Bug A: they were dropped
  // on persist, so Edit re-opened with none). They are a curation hint OFF `sameMeasure`,
  // so the form/agent/YAML convergence gate still holds even though YAML doesn't carry them.
  // "Revenue" differs from its slug "revenue" → label is auto-set so the tile shows the
  // human name, not the lowercased machine slug.
  assert.deepEqual(fromForm, { name: 'revenue', label: 'Revenue', type: 'sum', sql: 'net_amount', dimensions: ['order_date', 'region'] });
  assert.ok(sameMeasure(fromForm, fromAgent), 'form == agent');
  assert.ok(sameMeasure(fromForm, fromYaml), 'form == yaml (dimensions off sameMeasure)');
});

test('measureMember is the canonical member the agent metrics tool also builds', () => {
  const d = goldSales();
  const m = measureFromForm(REVENUE_FORM);
  // live-clients realCube builds `${cubeViewName(d).replace(/\s+/g,'')}.${measure}`.
  assert.equal(measureMember(d, m), 'Sales.revenue');
});

test('count needs no column; non-count needs one', () => {
  // "Orders" → "orders" (human name ≠ slug) → label auto-set.
  assert.deepEqual(measureFromForm({ name: 'Orders', aggregation: 'count', column: '', dimensions: [] }), { name: 'orders', label: 'Orders', type: 'count', sql: '' });
  assert.throws(() => measureFromForm({ name: 'Bad', aggregation: 'sum', column: '', dimensions: [] }), /needs a column/);
});

test('YAML parse errors and missing measures are reported, not silently dropped', () => {
  assert.throws(() => measureFromYaml('::: not yaml'), /invalid Cube YAML|not found|no measures/);
  assert.throws(() => measureFromYaml('cubes: [{name: x, measures: []}]', 'Revenue'), /no measures|not found/);
});

test('COMPOSITE metric survives the full store round-trip: create → persist (parseDataset) → hydrate → re-save', () => {
  // The two-path chooser's Complex path: a formula over the dataset's basic metrics.
  const siblings = [{ name: 'revenue', type: 'sum' }, { name: 'cost', type: 'sum' }];
  const form: MetricForm = {
    name: 'Gross margin', aggregation: 'number', column: '', dimensions: [],
    formula: '([revenue] - [cost]) / [revenue]',
  };
  const measure = measureFromForm(form, siblings);
  assert.equal(measure.type, 'number');
  assert.equal(measure.formula, form.formula, 'source formula rides on the measure');
  assert.match(measure.sql, /NULLIF/, 'division is null-safe');

  // Persist the way the store does — a dataset the registry parses back (dataset-schema).
  const persisted = parseDataset({ name: 'sales', measures: [measure] }).measures[0];
  assert.equal(persisted.formula, form.formula, 'formula survives persist/parse (0.6.48 fix holds)');
  assert.equal(persisted.sql, measure.sql, 'compiled sql survives persist/parse');

  // Hydrate the Edit form — a composite re-opens into the complex editor (formula set).
  const back = formFromMeasure(persisted);
  assert.equal(back.formula, form.formula, 'Edit recovers the source formula, not the NULLIF sql');
  assert.equal(back.aggregation, 'number');

  // Re-save converges on the identical measure (edit-in-place guarantee).
  assert.ok(sameMeasure(measureFromForm(back, siblings), measure), 'composite re-save converges');
});

test('BUG A: activated dimensions round-trip persist → parse → hydrate (Edit re-opens with them)', () => {
  // The define form activates two slice-by dimensions.
  const form: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['order_date', 'region'] };
  const measure = measureFromForm(form);
  assert.deepEqual(measure.dimensions, ['order_date', 'region'], 'dimensions persist onto the measure (were dropped before)');

  // Persist the way the store does and parse back through the registry schema.
  const persisted = parseDataset({ name: 'sales', measures: [measure] }).measures[0];
  assert.deepEqual(persisted.dimensions, ['order_date', 'region'], 'dimensions survive persist/parse');

  // Hydrate the Edit form — the dimensions come back ACTIVATED (the regression: they were []).
  const back = formFromMeasure(persisted);
  assert.deepEqual(back.dimensions, ['order_date', 'region'], 'Edit re-opens with the same dimensions activated');

  // A metric with NO dimensions stays byte-stable (field absent, form empty array).
  const plain = measureFromForm({ name: 'Orders', aggregation: 'count', column: '', dimensions: [] });
  assert.equal('dimensions' in plain, false, 'no dimensions ⇒ field absent (byte-stable)');
  assert.deepEqual(formFromMeasure(plain).dimensions, []);
});

test('metric name label: human name → label auto-set; bare slug → no label (tile shows the right name)', () => {
  // When the user types a human name that differs from its slug, the tile must show the
  // human name — so label is auto-set. A bare slug (already lowercase+underscore) is its
  // own label, so no extra field is written (byte-stable for existing metrics).
  const withLabel = measureFromForm({ name: 'Monthly Revenue', aggregation: 'count', column: '', dimensions: [] });
  assert.equal(withLabel.name, 'monthly_revenue', 'slug is the machine identity');
  assert.equal(withLabel.label, 'Monthly Revenue', 'label carries the human name for the tile');

  const noLabel = measureFromForm({ name: 'monthly_revenue', aggregation: 'count', column: '', dimensions: [] });
  assert.equal(noLabel.name, 'monthly_revenue', 'slug unchanged');
  assert.equal('label' in noLabel, false, 'bare slug → no label (byte-stable)');
});

test('formFromMeasure round-trips every generated measure shape onto the SAME member', () => {
  const forms: MetricForm[] = [
    { name: 'Orders', aggregation: 'count', column: '', dimensions: [] },
    { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] },
    {
      name: 'Won Deals', aggregation: 'count', column: '', dimensions: [],
      filter: { column: 'status', operator: 'equals', value: "won's" }, // quote-escaping round-trips
      rollingWindow: { amount: 7, unit: 'day' }, format: 'number',
    },
    { name: 'Cumulative', aggregation: 'sum', column: 'net_amount', dimensions: [], runningTotal: true },
    { name: 'AOV', aggregation: 'number', column: '', dimensions: [], ratio: { numerator: 'revenue', denominator: 'orders' } },
    { name: 'Nulls', aggregation: 'count', column: '', dimensions: [], filter: { column: 'region', operator: 'notSet', value: '' } },
  ];
  for (const f of forms) {
    const measure = measureFromForm(f);
    const back = formFromMeasure(measure);
    // The hydrated form re-saves onto the IDENTICAL measure — the edit-in-place guarantee.
    assert.ok(sameMeasure(measureFromForm(back), measure), `${f.name} round-trips`);
    assert.equal(back.name, measure.name, 'name is the frozen measure name, so slug() is a no-op');
  }
});
