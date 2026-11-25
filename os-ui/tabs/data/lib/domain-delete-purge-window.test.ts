/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The delete window and the Trino component: its tables count, the engine blocks
 * USER STORY: As the operator I want a domain holding tables (like any other artifact) deletable
 *             only during an announced delete window, refused outside it, never half-run.
 * ARCHITECTURE:
 *   - The Trino component with an in-memory Trino port feeds the REAL engine plan
 *     (`planDomainDelete`); the window is the engine's single block over every component's
 *     removals (core/kernel/domain-delete-window.test.ts has the cross-component twins). The real
 *     drops are proven in tests/domain-delete.
 *   - Twins: tables + closed window → blocked; tables + open window → not blocked; the component
 *     itself never blocks (no second, Trino-only window rule).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icebergComponent } from '@tabs/data/lib/domain-delete';
import { planDomainDelete, DELETE_WINDOW_COMPONENT } from '@core/kernel/domain-delete';

// A Trino that holds one table in the domain's own schema.
const withTable = {
  query: async (sql: string) => (sql.includes('information_schema.schemata') ? [['k']] : sql.includes('information_schema.tables') ? [['orders', 'BASE TABLE']] : []) as unknown[][],
  execute: async () => undefined,
};
const owner = async (id: string) => ({ id, role: 'admin' as const, domains: ['k'] });
const ctx = { domainId: 'k', actor: { id: 'alex', role: 'admin' as const, domains: ['k'] } };
const trino = () => icebergComponent({ trino: withTable, owner, soleMembers: async () => [] });

test('the Trino component plans its drops and carries no window block of its own', async () => {
  const p = await trino().plan(ctx);
  assert.ok(p.remove.length > 0, 'the domain has Trino objects to drop');
  assert.deepEqual(p.blocked, []);
});

test('tables + closed delete window → the engine blocks; open window → not blocked', async () => {
  const closed = await planDomainDelete([trino()], ctx, true, { windowOpen: () => false });
  assert.equal(closed.components.find((c) => c.component === DELETE_WINDOW_COMPONENT)?.blocked?.length, 1);
  const open = await planDomainDelete([trino()], ctx, true, { windowOpen: () => true });
  assert.equal(open.totals.blocked, 0);
});
