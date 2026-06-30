/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldCubeYaml } from '../data/metrics.ts';
import {
  measureFromForm,
  measureFromAgent,
  measureFromYaml,
  measureMember,
  sameMeasure,
  type MetricForm,
} from './model.ts';
import { goldSales } from './fixtures.ts';


const REVENUE_FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['order_date', 'region'] };

test('form / agent / YAML all produce the IDENTICAL measure (the same artifact)', () => {
  const d = goldSales();
  const fromForm = measureFromForm(REVENUE_FORM);
  const fromAgent = measureFromAgent({ ...REVENUE_FORM }); // agent returns the same structured proposal
  const fromYaml = measureFromYaml(scaffoldCubeYaml(d), 'Revenue');
  assert.deepEqual(fromForm, { name: 'revenue', type: 'sum', sql: 'net_amount' });
  assert.ok(sameMeasure(fromForm, fromAgent), 'form == agent');
  assert.ok(sameMeasure(fromForm, fromYaml), 'form == yaml');
});

test('measureMember is the canonical member the agent metrics tool also builds', () => {
  const d = goldSales();
  const m = measureFromForm(REVENUE_FORM);
  // live-clients realCube builds `${cubeViewName(d).replace(/\s+/g,'')}.${measure}`.
  assert.equal(measureMember(d, m), 'Sales.revenue');
});

test('count needs no column; non-count needs one', () => {
  assert.deepEqual(measureFromForm({ name: 'Orders', aggregation: 'count', column: '', dimensions: [] }), { name: 'orders', type: 'count', sql: '' });
  assert.throws(() => measureFromForm({ name: 'Bad', aggregation: 'sum', column: '', dimensions: [] }), /needs a column/);
});

test('YAML parse errors and missing measures are reported, not silently dropped', () => {
  assert.throws(() => measureFromYaml('::: not yaml'), /invalid Cube YAML|not found|no measures/);
  assert.throws(() => measureFromYaml('cubes: [{name: x, measures: []}]', 'Revenue'), /no measures|not found/);
});
