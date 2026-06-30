/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFromUser, delegate } from '../data/identity.ts';
import { type CubeExecutor, exploreSpec, buildCubeQuery, explore, dropToSql } from './explorer.ts';
import { measureFromForm, type MetricForm } from './model.ts';
import { goldSales } from './fixtures.ts';

const FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] };

/** An in-memory Cube that ENFORCES RLS from the security context (region filter). */
function rlsCube(): CubeExecutor {
  const all = [
    { region: 'DE', 'Sales.revenue': 1000 },
    { region: 'FR', 'Sales.revenue': 2000 },
    { region: 'US', 'Sales.revenue': 3000 },
  ];
  return {
    async load(_q, ctx) {
      const region = ctx.region as string | undefined;
      const rows = region ? all.filter((r) => r.region === region) : all;
      return { rows };
    },
  };
}

function tokenFor(id: string, region: string) {
  return delegate(claimsFromUser({ id, domains: ['sales'], role: 'participant', attributes: { region } }), 'domain');
}

test('explorer builds a Cube query for the canonical member + slice', () => {
  const d = goldSales();
  const spec = exploreSpec(d, measureFromForm(FORM), { dimensions: ['region'], timeDimension: 'order_date', granularity: 'month' });
  const q = buildCubeQuery(spec);
  assert.deepEqual(q.measures, ['Sales.revenue']);
  assert.deepEqual(q.dimensions, ['Sales.region']);
  assert.deepEqual(q.timeDimensions, [{ dimension: 'Sales.order_date', granularity: 'month' }]);
});

test('R3 — two viewers see DIFFERENT rows on the same metric (Cube RLS via securityContext)', async () => {
  const d = goldSales();
  const spec = exploreSpec(d, measureFromForm(FORM), { dimensions: ['region'] });
  const cube = rlsCube();
  const de = await explore(spec, tokenFor('amir', 'DE'), cube);
  const fr = await explore(spec, tokenFor('bea', 'FR'), cube);
  assert.deepEqual(de.rows, [{ region: 'DE', 'Sales.revenue': 1000 }]);
  assert.deepEqual(fr.rows, [{ region: 'FR', 'Sales.revenue': 2000 }]);
  assert.notDeepEqual(de.rows, fr.rows);
  assert.equal(de.securityContext.region, 'DE');
});

test('explore refuses a non-delegated (service) identity — RLS cannot collapse', async () => {
  const d = goldSales();
  const spec = exploreSpec(d, measureFromForm(FORM));
  // Forge a token that is not user-bound (onBehalfOf != sub) — propagate must throw.
  const bad = { ...tokenFor('amir', 'DE'), onBehalfOf: 'svc-superset' };
  await assert.rejects(() => explore(spec, bad as never, rlsCube()), /delegated identity/);
});

test('dropToSql exposes the same governed member as a SQL table', () => {
  const d = goldSales();
  const spec = exploreSpec(d, measureFromForm(FORM), { dimensions: ['region'] });
  const sql = dropToSql(spec);
  assert.match(sql, /FROM "Sales"/);
  assert.match(sql, /"revenue"/);
  assert.match(sql, /"region"/);
});
