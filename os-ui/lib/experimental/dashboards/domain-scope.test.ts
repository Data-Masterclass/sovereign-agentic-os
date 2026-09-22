/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/dashboards/store.ts → listDashboards.
 * Every tier (My/Domain/Company) narrows to the active domain; an owner's domain-A
 * dashboard must NOT leak into "My" while acting in domain B (the fixed fallthrough).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetDashboards, saveDashboard, transitionDashboard, listDashboards, type Principal } from './store.ts';
import type { DashboardSpec } from './model.ts';

// user.domains[0] decides the stamped domain on create → 'sales' here.
const uAll: Principal = { id: 'u1', domains: ['sales', 'finance'], role: 'admin' };
const uSales: Principal = { id: 'u1', domains: ['sales'], role: 'admin' };
const uFinance: Principal = { id: 'u1', domains: ['finance'], role: 'admin' };

const spec = (name: string): DashboardSpec => ({ name, view: 'daily_revenue', charts: [] });

beforeEach(() => __resetDashboards());

function seedSales(tier: 0 | 1 | 2): string {
  const id = `dash_${tier}_${Math.random().toString(36).slice(2, 7)}`;
  saveDashboard(uAll, id, spec(`D-${tier}`)); // personal, domain=sales
  if (tier >= 1) transitionDashboard(id, uAll, 'promote'); // → domain
  if (tier >= 2) transitionDashboard(id, uAll, 'certify'); // → marketplace (Company)
  return id;
}

function allIds(u: Principal) {
  const g = listDashboards(u);
  return new Set([...g.mine, ...g.domain, ...g.marketplace].map((s) => s.id));
}

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`${label} dashboard in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const id = seedSales(tier);
    assert.ok(!allIds(uFinance).has(id), `${label} sales dashboard HIDDEN in finance`);
    assert.ok(allIds(uSales).has(id), `${label} sales dashboard SHOWN in sales`);
    assert.ok(allIds(uAll).has(id), `${label} sales dashboard SHOWN under All Domains`);
  });
}

test('owned domain dashboard groups under Domain; owned Company under Company (never My)', () => {
  const dom = seedSales(1);
  const co = seedSales(2);
  const g = listDashboards(uSales);
  assert.ok(g.domain.some((s) => s.id === dom) && !g.mine.some((s) => s.id === dom), 'domain under Domain');
  assert.ok(g.marketplace.some((s) => s.id === co) && !g.mine.some((s) => s.id === co), 'Company under Company');
});
