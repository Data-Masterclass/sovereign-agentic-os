/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Exposure → OPA governance compile (lakehouse Expose, Phase 1). Proves each non-revoked
 * exposure emits a `data.governance.tables` entry keyed on the external FQN with the
 * EXACT shape the rego's `table_entitled` reads — matching the dataset compile output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileExposures } from './compiler.ts';

test('each exposed table → a shared governance entry keyed on <catalog>.<schema>.<table>', () => {
  const tables = compileExposures([
    {
      domain: 'sales',
      catalog: 'glue_sales',
      domains: ['commerce', 'marketing'],
      tables: [{ schema: 'public', table: 'orders' }, { schema: 'public', table: 'line_items' }],
    },
  ]);
  assert.deepEqual(tables['glue_sales.public.orders'], {
    domain: 'sales',
    visibility: 'shared',
    shared_with: ['commerce', 'marketing'], // sorted
    shared_with_users: [],
    sensitive_columns: {},
  });
  assert.ok(tables['glue_sales.public.line_items']);
  assert.equal(Object.keys(tables).length, 2);
});

test('domains are de-duplicated and sorted (byte-stable key set for the rego)', () => {
  const tables = compileExposures([
    { domain: 'sales', catalog: 'db', domains: ['z', 'a', 'a'], tables: [{ schema: 's', table: 't' }] },
  ]);
  assert.deepEqual(tables['db.s.t'].shared_with, ['a', 'z']);
});

test('a later exposure for the same FQN wins (last compiled)', () => {
  const tables = compileExposures([
    { domain: 'sales', catalog: 'db', domains: ['a'], tables: [{ schema: 's', table: 't' }] },
    { domain: 'sales', catalog: 'db', domains: ['b'], tables: [{ schema: 's', table: 't' }] },
  ]);
  assert.deepEqual(tables['db.s.t'].shared_with, ['b']);
});

test('no exposures → no entries (fail-closed floor governs everything)', () => {
  assert.deepEqual(compileExposures([]), {});
});
