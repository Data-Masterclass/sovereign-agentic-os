/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Unit pins for the data governance OPA writes.
 * USER STORY: As a domain member I want the governance push to add or update keys only, never
 *             replace the whole document, and every domain to map to itself.
 * ARCHITECTURE:
 *   - Pure (no OPA); the restore against the real OPA image is tests/opa/state-reconcile.int.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileOpa } from '@tabs/data/lib/policy/compiler';
import { governanceWrites } from '@tabs/data/lib/policy/opa-state-writes';

test('governance writes are per-key upserts and every extra domain maps to itself', () => {
  const bundle = compileOpa([], { alice: { domains: ['europace'] } }, ['europace', 'kiekert']);
  assert.deepEqual(bundle.principals.kiekert, { domains: ['kiekert'], clearances: [] });
  assert.deepEqual(bundle.principals.europace, { domains: ['europace'], clearances: [] });
  assert.deepEqual(bundle.principals.alice, { domains: ['europace'], clearances: [] });
  const tables = { 'iceberg.sales.gold_x': { domain: 'sales', visibility: 'shared', shared_with: [], shared_with_users: [], sensitive_columns: {} } } as unknown as typeof bundle.tables;
  const writes = governanceWrites({ tables, principals: bundle.principals });
  assert.ok(writes.every((w) => w.kind === 'data' && /^governance\/(tables|principals)\/[^/]+$/.test(w.path)), 'no whole-document replace');
  assert.ok(writes.some((w) => w.kind === 'data' && w.path === 'governance/tables/iceberg.sales.gold_x'));
});
