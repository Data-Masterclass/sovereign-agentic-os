/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/dashboards/store.ts → listDashboards.
 * Every tier (My/Domain/Company) narrows to the active domain; an owner's domain-A
 * dashboard must NOT leak into "My" while acting in domain B (the fixed fallthrough).
 * COMPANY EXCEPTION (owner decision 2026-11-23, core/kernel/company-scope): a Company item
 * is visible in EVERY domain, so the Company case asserts it is SHOWN in domain B.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetDashboards, saveDashboard, transitionDashboard, listDashboards, getDashboard, renameDashboard, type Principal } from '@tabs/dashboards/lib/store';
import type { DashboardSpec } from '@tabs/dashboards/lib/model';

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
  test(`${label} dashboard in domain A: ${label === 'Company' ? 'SHOWN' : 'hidden'} in B, shown in A, shown under All Domains`, () => {
    const id = seedSales(tier);
    if (label === 'Company') assert.ok(allIds(uFinance).has(id), `${label} sales dashboard VISIBLE (Company: every domain) in finance`);
    else assert.ok(!allIds(uFinance).has(id), `${label} sales dashboard HIDDEN in finance`);
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

// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

const zed: Principal = { id: 'zed', domains: ['finance'], role: 'creator' };

test('Company dashboard from sales: a finance member lists + gets it, cannot edit it; Domain twin hidden', () => {
  const company = seedSales(2);
  const domainOnly = seedSales(1);
  const g = listDashboards(zed);
  assert.ok(g.marketplace.some((s) => s.id === company), 'listed under Company');
  assert.equal(getDashboard(company, zed).id, company, 'opened by id');
  assert.throws(() => renameDashboard(company, zed, 'Hijacked'), 'cannot edit');
  assert.ok(![...g.mine, ...g.domain, ...g.marketplace].some((s) => s.id === domainOnly), 'Domain twin NOT listed');
  assert.throws(() => getDashboard(domainOnly, zed), 'Domain twin NOT openable');
});

// The MCP front door (the same list_*/get_* tools an agent run calls), as a member of ANOTHER domain.
async function mcpCall(user: { id: string; name?: string; domains: string[]; role: string }, name: string, args: Record<string, unknown> = {}) {
  const { handleRpc } = await import('@core/mcp/server');
  const res = await handleRpc({ name: user.id, ...user } as Parameters<typeof handleRpc>[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = (res as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, text: r.content[0].text };
}

test('MCP: list_dashboards + get_dashboard show the Company dashboard to a finance member; Domain twin hidden', async () => {
  const co = seedSales(2);
  const dom = seedSales(1);
  const list = await mcpCall(zed, 'list_dashboards');
  assert.ok(list.text.includes(co), 'Company dashboard listed');
  assert.ok(!list.text.includes(dom), 'Domain twin not listed');
  assert.equal((await mcpCall(zed, 'get_dashboard', { dashboardId: co })).isError, false);
  assert.equal((await mcpCall(zed, 'get_dashboard', { dashboardId: dom })).isError, true);
});

test('folder cascade: a finance admin\'s domain-folder cascade never touches a sales Company dashboard (visible ≠ member)', async () => {
  const { dashboardsAdapter } = await import('@tabs/dashboards/lib/folder-adapter');
  const co = seedSales(2);
  const finAdmin = { id: 'fa', domains: ['finance'], role: 'admin' };
  assert.ok(allIds(finAdmin as Principal).has(co), 'visible in the list');
  assert.ok(!dashboardsAdapter.itemsUnderFolder(finAdmin, 'domain', '/').some((i) => i.id === co), 'not a member of finance folders');
  assert.ok(dashboardsAdapter.itemsUnderFolder({ id: 'sa', domains: ['sales'], role: 'admin' }, 'domain', '/').some((i) => i.id === co), 'still a member of sales folders');
});
