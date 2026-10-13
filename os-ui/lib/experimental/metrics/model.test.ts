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
  filterSql,
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

// ---- H0: SQL injection in the metrics builder (column / filter.column) -----------
// A metric's `column` and `filter.column` flow verbatim into executed Cube/Trino SQL
// (the aggregation `sql:` and the `{CUBE}.<col>` filter predicate). They must be
// validated as bare column identifiers — an injected expression/subquery is rejected,
// never quoted-and-hoped, so it can't alter the query shape.

const INJECTIONS = [
  'x) UNION SELECT password FROM users --',
  'a"; DROP TABLE orders',
  "net_amount) FROM t WHERE 1=1 OR ('1'='1",
  'sum(secret)',
  'col; DELETE FROM t',
  'a OR 1=1',
  'a.b',            // qualified — not a bare column, must be rejected
  'a-b',            // arithmetic — rejected
  'a b',            // whitespace — rejected
  '1col',          // must start with a letter/underscore
  '',              // empty column for a non-count aggregation
];

test('H0: an injected aggregation column is REJECTED (never reaches SQL)', () => {
  for (const bad of INJECTIONS) {
    assert.throws(
      () => measureFromForm({ name: 'Evil', aggregation: 'sum', column: bad, dimensions: [] }),
      /invalid metric column|needs a column/,
      `sum column '${bad}' must be rejected`,
    );
  }
  // A legitimate bare column still compiles to exactly the column name (unchanged).
  const ok = measureFromForm({ name: 'Rev', aggregation: 'sum', column: 'net_amount', dimensions: [] });
  assert.equal(ok.sql, 'net_amount');
});

test('H0: an injected filter column is REJECTED and cannot alter the predicate shape', () => {
  for (const bad of INJECTIONS.filter((b) => b !== '')) {
    assert.throws(
      () => filterSql({ column: bad, operator: 'equals', value: 'x' }),
      /invalid filter column/,
      `filter column '${bad}' must be rejected`,
    );
    // …and through the full form path (measureFromForm builds the filter).
    assert.throws(
      () => measureFromForm({
        name: 'Evil', aggregation: 'count', column: '', dimensions: [],
        filter: { column: bad, operator: 'equals', value: 'x' },
      }),
      /invalid filter column/,
    );
  }
  // A legitimate bare filter column compiles to a safe `{CUBE}.<col>` predicate.
  assert.equal(filterSql({ column: 'status', operator: 'equals', value: 'won' }), "{CUBE}.status = 'won'");
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
