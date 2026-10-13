/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetDashboards, saveDashboard, getDashboardsForView, type Principal } from './store.ts';
import type { DashboardSpec } from './model.ts';

// Reverse lookup: which of the user's visible dashboards bind to a given Cube view.

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

function spec(name: string, view: string): DashboardSpec {
  return { name, view, charts: [] };
}

beforeEach(() => __resetDashboards());

test('returns only dashboards bound to the given view', () => {
  saveDashboard(amir, 'd1', spec('Sales KPIs', 'sales_orders'));
  saveDashboard(amir, 'd2', spec('Other', 'marketing_leads'));
  const rows = getDashboardsForView('sales_orders', amir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Sales KPIs');
});

test('no dashboards on a view returns empty (calm, never fabricated)', () => {
  saveDashboard(amir, 'd1', spec('Sales KPIs', 'sales_orders'));
  assert.deepEqual(getDashboardsForView('unknown_view', amir), []);
});

test('visibility holds — a stranger sees none of the owner personal dashboards', () => {
  saveDashboard(amir, 'd1', spec('Sales KPIs', 'sales_orders'));
  const stranger: Principal = { id: 'zed', domains: [], role: 'creator' };
  assert.equal(getDashboardsForView('sales_orders', stranger).length, 0);
});
