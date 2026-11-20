/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The purge window: a delete-domain run is BLOCKED unless the purge catalog is on
 * USER STORY: As the operator I want the purge capability to exist only during an announced
 *             delete window, and a delete started outside it to be refused, not half-run.
 * ARCHITECTURE:
 *   - The Trino component with an in-memory Trino port (the window is a plan rule; the real drops
 *     are proven in tests/domain-delete). Negative twin: the open window plans no block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icebergComponent } from '@tabs/data/lib/domain-delete';

const port = { query: async () => [] as unknown[][], execute: async () => undefined };
const owner = async (id: string) => ({ id, role: 'admin' as const, domains: ['k'] });
const ctx = { domainId: 'k', actor: { id: 'alex', role: 'admin' as const, domains: ['k'] } };

test('closed window → blocked; open window → not blocked', async () => {
  const closed = await icebergComponent({ trino: port, owner, soleMembers: async () => [], purgeEnabled: () => false }).plan(ctx);
  assert.equal(closed.blocked?.[0]?.kind, 'purge-window');
  const open = await icebergComponent({ trino: port, owner, soleMembers: async () => [], purgeEnabled: () => true }).plan(ctx);
  assert.deepEqual(open.blocked, []);
});
