/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  privatePrefix,
  pullExtract,
  assertSandboxScoped,
  promotePlan,
  type SandboxDataset,
} from './sandbox.ts';

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

test('pull-extract REFUSES any path that did not go through Trino', async () => {
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

test('sandbox DuckDB cannot reference a governed catalog/mart (the invariant)', () => {
  // governed marts live in the iceberg/polaris catalog — DuckDB must not touch them.
  assert.throws(() => assertSandboxScoped('select * from iceberg.sales.daily_revenue'), /governed/i);
  assert.throws(() => assertSandboxScoped('SELECT * FROM Polaris.analytics.t'), /governed/i);
  // a user's own uploads / pulled extracts are fine.
  assert.doesNotThrow(() => assertSandboxScoped('select * from my_upload join sales_snapshot using (id)'));
});

test('promote is the ONLY sandbox->shared path: dbt-trino writes Iceberg + OpenMetadata', () => {
  const d: SandboxDataset = { id: 'x', name: 'My Sales Cut', origin: 'extract', columns: [], rows: [] };
  const plan = promotePlan(d, { domain: 'sales', owner: 'alice', visibility: 'shared' });
  assert.equal(plan.engine, 'dbt-trino');
  assert.equal(plan.target, 'iceberg.sales.my_sales_cut');
  assert.equal(plan.catalog, 'openmetadata');
  assert.equal(plan.visibility, 'shared');
});
