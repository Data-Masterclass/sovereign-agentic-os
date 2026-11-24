/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The purge window: a delete-domain run is BLOCKED unless the purge catalog is on
 * USER STORY: As the operator I want the purge capability to exist only during an announced
 *             delete window, and a delete started outside it to be refused, not half-run.
 * ARCHITECTURE:
 *   - The Trino component with an in-memory Trino port (the window is a plan rule; the real drops
 *     are proven in tests/domain-delete). Negative twins: the open window plans no block, and a
 *     domain with nothing in Trino to drop needs no window at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icebergComponent } from '@tabs/data/lib/domain-delete';

const port = { query: async () => [] as unknown[][], execute: async () => undefined };
// A Trino that holds one table in the domain's own schema: something the purge catalog must drop.
const withTable = {
  query: async (sql: string) => (sql.includes('information_schema.schemata') ? [['k']] : sql.includes('information_schema.tables') ? [['orders', 'BASE TABLE']] : []) as unknown[][],
  execute: async () => undefined,
};
const owner = async (id: string) => ({ id, role: 'admin' as const, domains: ['k'] });
const ctx = { domainId: 'k', actor: { id: 'alex', role: 'admin' as const, domains: ['k'] } };

test('closed window + Trino objects to drop → blocked; open window → not blocked', async () => {
  const closed = await icebergComponent({ trino: withTable, owner, soleMembers: async () => [], purgeEnabled: () => false }).plan(ctx);
  assert.ok(closed.remove.length > 0, 'the domain has Trino objects to drop');
  assert.equal(closed.blocked?.[0]?.kind, 'purge-window');
  const open = await icebergComponent({ trino: withTable, owner, soleMembers: async () => [], purgeEnabled: () => true }).plan(ctx);
  assert.deepEqual(open.blocked, []);
  assert.equal(open.remove.length, closed.remove.length);
});

// Dev, 2026-11-24: deleting `marketing`/`ops` (no tables, no schema) was refused for a closed purge
// window it never needed: the window only governs the purge catalog's DROPs, and there were none.
test('closed window but nothing in Trino to drop → not blocked (the window is not needed)', async () => {
  const closed = await icebergComponent({ trino: port, owner, soleMembers: async () => [], purgeEnabled: () => false }).plan(ctx);
  assert.deepEqual(closed.remove, []);
  assert.deepEqual(closed.blocked, []);
});
