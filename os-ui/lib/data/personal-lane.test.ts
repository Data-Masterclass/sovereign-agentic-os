/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  privatePrefix,
  pullExtract,
  assertScopedToSelf,
  promotePlan,
  type PersonalDataset,
} from './personal-lane.ts';

test('private prefix is per-user and isolated', () => {
  assert.equal(privatePrefix('alice'), 's3://sandbox/alice/');
  assert.notEqual(privatePrefix('alice'), privatePrefix('bob'));
});

test('pull-extract goes THROUGH Trino (governed/masked) and lands as a private extract', async () => {
  let sawPrincipal = '';
  const ds = await pullExtract({
    principal: 'marketing',
    sql: 'select region, revenue from daily_revenue',
    name: 'sales snapshot',
    queryFn: async (_sql, principal) => {
      sawPrincipal = principal;
      // Trino already applied OPA row/column masking on the way out.
      return { engine: 'trino', columns: ['region', 'revenue'], rows: [['DE', '100']] };
    },
  });
  assert.equal(sawPrincipal, 'marketing'); // identity forwarded so Trino governs the right user
  assert.equal(ds.origin, 'extract');
  assert.deepEqual(ds.columns, ['region', 'revenue']);
});

test('pull-extract REFUSES any path that did not go through Trino (single engine)', async () => {
  await assert.rejects(
    pullExtract({
      principal: 'p',
      sql: 'x',
      name: 'n',
      queryFn: async () => ({ engine: 'duckdb', columns: [], rows: [] }),
    }),
    /must go through Trino/i,
  );
});

test('a personal-lane query cannot reference a governed catalog/mart (the invariant)', () => {
  assert.throws(() => assertScopedToSelf('select * from iceberg.sales.daily_revenue'), /governed/i);
  assert.throws(() => assertScopedToSelf('SELECT * FROM Polaris.analytics.t'), /governed/i);
  // a user's own uploads / pulled extracts are fine.
  assert.doesNotThrow(() => assertScopedToSelf('select * from my_upload join sales_snapshot using (id)'));
});

test('promote is the ONLY personal->shared path: dbt-trino writes Iceberg + OpenMetadata', () => {
  const d: PersonalDataset = { id: 'x', name: 'My Sales Cut', origin: 'extract', columns: [], rows: [] };
  const plan = promotePlan(d, { domain: 'sales', owner: 'alice', visibility: 'shared' });
  assert.equal(plan.engine, 'dbt-trino');
  assert.equal(plan.target, 'iceberg.sales.my_sales_cut');
  assert.equal(plan.catalog, 'openmetadata');
  assert.equal(plan.visibility, 'shared');
});

test('promote normalizes a hyphenated domain to a valid Trino schema (dash->underscore)', () => {
  const d: PersonalDataset = { id: 'x', name: 'Cohort Cut', origin: 'extract', columns: [], rows: [] };
  const plan = promotePlan(d, { domain: 'agentic-leader-q3-2026', owner: 'alice', visibility: 'shared' });
  // The target schema must match the real Iceberg schema, not the dashed domain id.
  assert.equal(plan.target, 'iceberg.agentic_leader_q3_2026.cohort_cut');
});
