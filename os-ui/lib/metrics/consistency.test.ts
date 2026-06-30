/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldCubeYaml } from '../data/metrics.ts';
import { convergence, numbersMatch, consistencyCheck } from './consistency.ts';
import { measureFromForm, type MetricForm } from './model.ts';
import { goldSales } from './fixtures.ts';

const FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] };

test('convergence proves form/agent/YAML are one artifact + member', () => {
  const d = goldSales();
  const r = convergence(d, { form: FORM, agent: { ...FORM }, yaml: scaffoldCubeYaml(d) });
  assert.ok(r.ok, JSON.stringify(r.rows));
  assert.equal(r.member, 'Sales.revenue');
});

test('convergence FAILS when the agent diverges from the form (caught, not shipped)', () => {
  const d = goldSales();
  const r = convergence(d, { form: FORM, agent: { ...FORM, aggregation: 'avg' }, yaml: scaffoldCubeYaml(d) });
  assert.equal(r.ok, false);
  assert.ok(r.rows.some((x) => x.name === 'form == agent' && !x.ok));
});

test('numbersMatch — explorer == dashboard == agent on the same member', async () => {
  const member = 'Sales.revenue';
  const resolver = async (m: string) => (m === member ? 42000 : null);
  const r = await numbersMatch(member, { explorer: resolver, dashboard: resolver, agent: resolver });
  assert.ok(r.ok, r.detail);
  // a consumer that disagrees fails the check
  const bad = await numbersMatch(member, { explorer: resolver, dashboard: async () => 41999, agent: resolver });
  assert.equal(bad.ok, false);
});

test('consistencyCheck is the promotion gate: documented + defined + resolves', async () => {
  const d = goldSales();
  const m = measureFromForm(FORM);
  const ok = await consistencyCheck(d, m, async () => 42000);
  assert.ok(ok.ok, JSON.stringify(ok.rows));
  assert.equal(ok.member, 'Sales.revenue');

  // undocumented dataset (no column descriptions) → gate red
  const undoc = goldSales({ columns: [{ name: 'order_id', description: '' }, { name: 'net_amount', description: '' }] });
  const red = await consistencyCheck(undoc, m, async () => 1);
  assert.equal(red.ok, false);

  // does not resolve → gate red
  const noResolve = await consistencyCheck(d, m, async () => null);
  assert.equal(noResolve.ok, false);
});
