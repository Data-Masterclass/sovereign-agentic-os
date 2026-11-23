/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/files/store.ts → listFiles.
 * Every tier (My/Domain/Company) narrows to the active domain; the fixed leak is
 * that canRead returns true for the OWNER regardless of domain, so an owner's
 * domain-A asset used to leak into Domain while acting in domain B.
 * COMPANY EXCEPTION (owner decision 2026-11-23, core/kernel/company-scope): a Company item
 * is visible in EVERY domain, so the Company case asserts it is SHOWN in domain B.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetStore, createFile, transition, listFiles, getFile, renameFile, type Principal } from '@tabs/files/lib/store';
import { compileDls, evaluateDls } from '@tabs/files/lib/dls';

const uAll: Principal = { id: 'u1', domains: ['sales', 'finance'], role: 'admin' };
const uSales: Principal = { id: 'u1', domains: ['sales'], role: 'admin' };
const uFinance: Principal = { id: 'u1', domains: ['finance'], role: 'admin' };

beforeEach(() => __resetStore());

function seedSales(tier: 0 | 1 | 2): string {
  const a = createFile(uAll, { name: `F-${tier}`, domain: 'sales', text: 'hello' });
  if (tier >= 1) transition(a.id, uAll, 'promote', { visibility: 'domain' }); // → asset (sales)
  if (tier >= 2) transition(a.id, uAll, 'certify', { visibility: 'domain' }); // → product (sales)
  return a.id;
}

function allIds(u: Principal) {
  const g = listFiles(u);
  return new Set([...g.mine, ...g.domain, ...g.marketplace].map((s) => s.id));
}

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`${label} file in domain A: ${label === 'Company' ? 'SHOWN' : 'hidden'} in B, shown in A, shown under All Domains`, () => {
    const id = seedSales(tier);
    if (label === 'Company') assert.ok(allIds(uFinance).has(id), `${label} sales file VISIBLE (Company: every domain) in finance`);
    else assert.ok(!allIds(uFinance).has(id), `${label} sales file HIDDEN in finance`);
    assert.ok(allIds(uSales).has(id), `${label} sales file SHOWN in sales`);
    assert.ok(allIds(uAll).has(id), `${label} sales file SHOWN under All Domains`);
  });
}

test('owned asset groups under Domain; owned product under Company (never My)', () => {
  const asset = seedSales(1);
  const product = seedSales(2);
  const g = listFiles(uSales);
  assert.ok(g.domain.some((s) => s.id === asset) && !g.mine.some((s) => s.id === asset), 'asset under Domain');
  assert.ok(g.marketplace.some((s) => s.id === product) && !g.mine.some((s) => s.id === product), 'product under Company');
});

// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

const zed: Principal = { id: 'zed', domains: ['finance'], role: 'creator' };

test('Company file from sales: a finance member lists, gets and SEARCHES it, cannot edit it; Domain twin hidden', () => {
  const company = seedSales(2);
  const domainOnly = seedSales(1);
  const g = listFiles(zed);
  assert.ok(g.marketplace.some((s) => s.id === company), 'listed under Company');
  assert.equal(getFile(company, zed).asset.id, company, 'opened by id');
  assert.throws(() => renameFile(company, zed, 'Hijacked'), (e: { status?: number }) => e.status === 403, 'cannot edit');
  // The compiled OpenSearch DLS filter (search_files / /api/files/search) admits it too.
  const dls = compileDls({ id: zed.id, domains: zed.domains });
  assert.equal(evaluateDls(dls, { owner: 'u1', tier: 'product', domain: 'sales', grantedUsers: [] }), true, 'DLS admits Company');
  assert.equal(evaluateDls(dls, { owner: 'u1', tier: 'asset', domain: 'sales', grantedUsers: [] }), false, 'DLS refuses the Domain twin');
  assert.ok(![...g.mine, ...g.domain, ...g.marketplace].some((s) => s.id === domainOnly), 'Domain twin NOT listed');
  assert.throws(() => getFile(domainOnly, zed), 'Domain twin NOT openable');
});

// The MCP front door (the same list_*/get_* tools an agent run calls), as a member of ANOTHER domain.
async function mcpCall(user: { id: string; name?: string; domains: string[]; role: string }, name: string, args: Record<string, unknown> = {}) {
  const { handleRpc } = await import('@core/mcp/server');
  const res = await handleRpc({ name: user.id, ...user } as Parameters<typeof handleRpc>[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = (res as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, text: r.content[0].text };
}

test('MCP: list_files + get_file show the Company file to a finance member; Domain twin hidden', async () => {
  const co = seedSales(2);
  const dom = seedSales(1);
  const list = await mcpCall(zed, 'list_files');
  assert.ok(list.text.includes(co), 'Company file listed');
  assert.ok(!list.text.includes(dom), 'Domain twin not listed');
  assert.equal((await mcpCall(zed, 'get_file', { fileId: co })).isError, false, 'get_file works');
  assert.equal((await mcpCall(zed, 'get_file', { fileId: dom })).isError, true, 'Domain twin not gettable');
});

test('folder cascade: a finance admin\'s domain-folder cascade never touches a sales Company file (visible ≠ member)', async () => {
  const { filesAdapter } = await import('@tabs/files/lib/folder-adapter');
  const co = seedSales(2);
  const finAdmin = { id: 'fa', domains: ['finance'], role: 'admin' };
  assert.ok(allIds(finAdmin as Principal).has(co), 'visible in the list');
  assert.ok(!filesAdapter.itemsUnderFolder(finAdmin, 'domain', '/').some((i) => i.id === co), 'not a member of finance folders');
  assert.ok(filesAdapter.itemsUnderFolder({ id: 'sa', domains: ['sales'], role: 'admin' }, 'domain', '/').some((i) => i.id === co), 'still a member of sales folders');
});
