/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/data/store.ts → listDatasets.
 *
 * THE RULE: every tier — My (dataset), Domain (asset), Company (product) — narrows
 * to the ACTIVE domain. A dataset created in domain A is hidden when domain B is
 * active, shown when A is active, shown under "All Domains". Applies to the owner
 * too (canView returns true for the owner regardless of domain — the fixed bypass).
 * An owned promoted asset groups under Domain; an owned certified product under Company.
 * COMPANY EXCEPTION (owner decision 2026-11-23, core/kernel/company-scope): a Company item
 * is visible in EVERY domain, so the Company case asserts it is SHOWN in domain B.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetStore, createDataset, buildVersion, transition, listAskable, listDatasets, getDataset, renameDataset, type Principal } from '@tabs/data/lib/store';

// One admin who belongs to BOTH sales + finance; auth.ts narrows domains to the active one.
const uAll: Principal = { id: 'u1', domains: ['sales', 'finance'], role: 'admin' };
const uSales: Principal = { id: 'u1', domains: ['sales'], role: 'admin' };
const uFinance: Principal = { id: 'u1', domains: ['finance'], role: 'admin' };

beforeEach(() => __resetStore());

/** Build a sales dataset at a chosen tier: 0=My(dataset) 1=Domain(asset) 2=Company(product). */
function seedSales(tier: 0 | 1 | 2): string {
  const d = createDataset(uAll, { name: `DS-${tier}`, domain: 'sales' });
  buildVersion(d.id, uAll, 'bronze', { quality: 'passing', artifact: 'bronze/x.dlt.yml' });
  buildVersion(d.id, uAll, 'silver', { quality: 'passing', artifact: 'silver/x.sql' });
  if (tier >= 1) transition(d.id, uAll, 'promote', { visibility: 'domain' }); // → asset (sales)
  if (tier >= 2) transition(d.id, uAll, 'certify', { visibility: 'shared' }); // → product (sales)
  return d.id;
}

function allIds(u: Principal) {
  const g = listDatasets(u);
  return new Set([...g.mine, ...g.domain, ...g.marketplace].map((s) => s.id));
}

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`${label} dataset in domain A: ${label === 'Company' ? 'SHOWN' : 'hidden'} in B, shown in A, shown under All Domains`, () => {
    const id = seedSales(tier);
    if (label === 'Company') assert.ok(allIds(uFinance).has(id), `${label} sales dataset VISIBLE (Company: every domain) when active domain is finance`);
    else assert.ok(!allIds(uFinance).has(id), `${label} sales dataset HIDDEN when active domain is finance`);
    assert.ok(allIds(uSales).has(id), `${label} sales dataset SHOWN when active domain is sales`);
    assert.ok(allIds(uAll).has(id), `${label} sales dataset SHOWN under All Domains`);
  });
}

test('an owned promoted asset groups under Domain; an owned certified product under Company', () => {
  const asset = seedSales(1);
  const product = seedSales(2);
  const g = listDatasets(uSales);
  assert.ok(g.domain.some((s) => s.id === asset), 'owned asset under Domain');
  assert.ok(!g.mine.some((s) => s.id === asset), 'owned asset NOT under My');
  assert.ok(g.marketplace.some((s) => s.id === product), 'owned product under Company');
  assert.ok(!g.mine.some((s) => s.id === product), 'owned product NOT under My');
});

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`Talk-to-Data evidence (listAskable): ${label} sales dataset ${label === 'Company' ? 'cited in every domain' : 'never cited under another active domain'}`, () => {
    const id = seedSales(tier);
    const askable = (u: Principal) => new Set(listAskable(u).map((d) => d.id));
    if (label === 'Company') assert.ok(askable(uFinance).has(id), `${label} sales dataset askable in every domain (Company scope)`);
    else assert.ok(!askable(uFinance).has(id), `${label} sales dataset NOT askable when finance is active`);
    assert.ok(askable(uSales).has(id), `${label} sales dataset askable when sales is active`);
    assert.ok(askable(uAll).has(id), `${label} sales dataset askable under All Domains`);
  });
}

// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

const zed: Principal = { id: 'zed', domains: ['finance'], role: 'creator' };

test('Company dataset from sales: a finance member lists + gets it, cannot edit it; Domain twin hidden', () => {
  const company = seedSales(2);
  const domainOnly = seedSales(1);
  const g = listDatasets(zed);
  assert.ok(g.marketplace.some((s) => s.id === company), 'listed under Company for the finance member');
  assert.equal(getDataset(company, zed).id, company, 'opened by id');
  assert.throws(() => renameDataset(company, zed, 'Hijacked'), (e: { status?: number }) => e.status === 403, 'cannot edit');
  assert.ok(![...g.mine, ...g.domain, ...g.marketplace].some((s) => s.id === domainOnly), 'Domain twin NOT listed');
  assert.throws(() => getDataset(domainOnly, zed), 'Domain twin NOT openable');
});

// The MCP front door (the same list_*/get_* tools an agent run calls), as a member of ANOTHER domain.
async function mcpCall(user: { id: string; name?: string; domains: string[]; role: string }, name: string, args: Record<string, unknown> = {}) {
  const { handleRpc } = await import('@core/mcp/server');
  const res = await handleRpc({ name: user.id, ...user } as Parameters<typeof handleRpc>[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = (res as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, text: r.content[0].text };
}

test('MCP: list_datasets + get_dataset show the Company dataset to a finance member; Domain twin hidden', async () => {
  const co = seedSales(2);
  const dom = seedSales(1);
  const list = await mcpCall(zed, 'list_datasets');
  assert.ok(list.text.includes(co), 'Company dataset listed');
  assert.ok(!list.text.includes(dom), 'Domain twin not listed');
  assert.equal((await mcpCall(zed, 'get_dataset', { datasetId: co })).isError, false, 'get_dataset works');
  assert.equal((await mcpCall(zed, 'get_dataset', { datasetId: dom })).isError, true, 'Domain twin not gettable');
});

test('folder cascade: a finance admin\'s domain-folder cascade never touches a sales Company dataset (visible ≠ member)', async () => {
  const { dataAdapter } = await import('@tabs/data/lib/folder-adapter');
  const co = seedSales(2);
  const finAdmin = { id: 'fa', domains: ['finance'], role: 'admin' };
  assert.ok(listDatasets(finAdmin as Principal).marketplace.some((s) => s.id === co), 'visible in the list');
  assert.ok(!dataAdapter.itemsUnderFolder(finAdmin, 'domain', '/').some((i) => i.id === co), 'not a member of finance folders');
  assert.ok(dataAdapter.itemsUnderFolder({ id: 'sa', domains: ['sales'], role: 'admin' }, 'domain', '/').some((i) => i.id === co), 'still a member of sales folders');
});
