/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetDashboards, listDashboards, getDashboard, saveDashboard, type Principal } from './store.ts';
import type { DashboardSpec } from './model.ts';

const admin: Principal = { id: 'sara', domains: ['sales'], role: 'admin' };
const builder: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

function spec(name = 'My Dash'): DashboardSpec {
  return { name, view: 'mine', charts: [] };
}

beforeEach(() => __resetDashboards());

test('fresh store starts empty (SEED is empty)', () => {
  const { mine, domain, marketplace } = listDashboards(admin);
  assert.equal(mine.length + domain.length + marketplace.length, 0);
});

test('saveDashboard creates a record owned by the user', () => {
  saveDashboard(builder, 'dash_1', spec('Sales KPIs'));
  const { mine } = listDashboards(builder);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].name, 'Sales KPIs');
});

test('getDashboard returns the record for the owner', () => {
  saveDashboard(builder, 'dash_2', spec('Revenue'));
  const d = getDashboard('dash_2', builder);
  assert.equal(d.id, 'dash_2');
});

test('getDashboard throws 403 for a non-owner without domain access', () => {
  saveDashboard(builder, 'dash_3', spec('Private'));
  const other: Principal = { id: 'other', domains: [], role: 'creator' };
  assert.throws(() => getDashboard('dash_3', other), (e: { status?: number }) => e.status === 403);
});

test('globalThis pin: dashState is shared under soa.dashboards.store', () => {
  saveDashboard(builder, 'dash_g', spec('Pinned'));
  const pinned = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.dashboards.store')] as { dashboards: unknown[] };
  assert.ok(pinned, 'state must be present on globalThis');
  assert.equal(pinned.dashboards.length, 1, 'saved dashboard must appear in globalThis state');
});
