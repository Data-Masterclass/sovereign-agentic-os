/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/knowledge/store.ts → listWorkflows AND
 * lib/knowledge/personal-store.ts → listPersonalKnowledge. Every tier narrows to the
 * active domain; an owned Shared workflow groups under Domain, an owned Marketplace one
 * under Company.
 * COMPANY EXCEPTION (owner decision 2026-11-23, core/kernel/company-scope): a Company item
 * is visible in EVERY domain, so the Company case asserts it is SHOWN in domain B.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetStore as resetWf,
  createWorkflow,
  publishWorkflow,
  certifyWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  type Principal as WfPrincipal,
} from '@tabs/knowledge/lib/store';
import {
  __resetStore as resetPk,
  createPersonalKnowledge,
  promotePersonalKnowledge,
  certifyPersonalKnowledge,
  listPersonalKnowledge,
  getPersonalKnowledge,
  updatePersonalKnowledge,
} from '@tabs/knowledge/lib/personal-store';
import { canSee } from '@tabs/knowledge/lib/retrieve-core';

const uAll: WfPrincipal = { id: 'u1', domains: ['sales', 'finance'], role: 'admin' };
const uSales: WfPrincipal = { id: 'u1', domains: ['sales'], role: 'admin' };
const uFinance: WfPrincipal = { id: 'u1', domains: ['finance'], role: 'admin' };

// -------------------------------------------------------------- workflows ----

beforeEach(() => { resetWf(); resetPk(); });

function seedWf(tier: 0 | 1 | 2): string {
  const rec = createWorkflow(uAll, { title: `WF-${tier}`, domain: 'sales' });
  if (tier >= 1) publishWorkflow(rec.id, uAll); // Personal → Shared
  if (tier >= 2) certifyWorkflow(rec.id, uAll); // Shared → Marketplace (Company)
  return rec.id;
}

function wfIds(u: WfPrincipal) {
  const g = listWorkflows(u);
  return { all: new Set([...g.mine, ...g.domain, ...g.marketplace].map((s) => s.id)), g };
}

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`workflow ${label} in domain A: ${label === 'Company' ? 'SHOWN' : 'hidden'} in B, shown in A, shown under All Domains`, () => {
    const id = seedWf(tier);
    if (label === 'Company') assert.ok(wfIds(uFinance).all.has(id), `${label} sales workflow VISIBLE (Company: every domain) in finance`);
    else assert.ok(!wfIds(uFinance).all.has(id), `${label} sales workflow HIDDEN in finance`);
    assert.ok(wfIds(uSales).all.has(id), `${label} sales workflow SHOWN in sales`);
    assert.ok(wfIds(uAll).all.has(id), `${label} sales workflow SHOWN under All Domains`);
  });
}

test('owned Shared workflow groups under Domain; owned Marketplace under Company', () => {
  const shared = seedWf(1);
  const market = seedWf(2);
  const { g } = wfIds(uSales);
  assert.ok(g.domain.some((s) => s.id === shared) && !g.mine.some((s) => s.id === shared), 'Shared under Domain');
  assert.ok(g.marketplace.some((s) => s.id === market) && !g.mine.some((s) => s.id === market), 'Marketplace under Company');
});

// ---------------------------------------------------- personal knowledge -----
// listPersonalKnowledge narrows via the explicit `activeDomain` opt (its own switcher
// mechanism), so we pass it directly rather than narrowing user.domains.

function seedPk(tier: 0 | 1 | 2): string {
  const rec = createPersonalKnowledge(uAll, { title: `PK-${tier}`, domain: 'sales' });
  if (tier >= 1) promotePersonalKnowledge(rec.id, uAll); // → Shared
  if (tier >= 2) certifyPersonalKnowledge(rec.id, uAll); // → Marketplace (Company)
  return rec.id;
}

function pkIds(activeDomain: string | null) {
  const g = listPersonalKnowledge(uAll, { activeDomain });
  return { all: new Set([...g.mine, ...g.domain, ...g.marketplace].map((s) => s.id)), g };
}

for (const [label, tier] of [['My', 0], ['Domain', 1], ['Company', 2]] as const) {
  test(`personal-knowledge ${label} in domain A: ${label === 'Company' ? 'SHOWN' : 'hidden'} in B, shown in A, shown under All Domains`, () => {
    const id = seedPk(tier);
    if (label === 'Company') assert.ok(pkIds('finance').all.has(id), `${label} sales entry VISIBLE (Company: every domain) when active domain is finance`);
    else assert.ok(!pkIds('finance').all.has(id), `${label} sales entry HIDDEN when active domain is finance`);
    assert.ok(pkIds('sales').all.has(id), `${label} sales entry SHOWN when active domain is sales`);
    assert.ok(pkIds(null).all.has(id), `${label} sales entry SHOWN under All Domains`);
  });
}

// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

const zed: WfPrincipal = { id: 'zed', domains: ['finance'], role: 'creator' };

test('Company workflow from sales: a finance member lists + gets it, cannot edit it; Domain twin hidden', () => {
  const company = seedWf(2);
  const domainOnly = seedWf(1);
  const { all, g } = wfIds(zed);
  assert.ok(g.marketplace.some((s) => s.id === company), 'listed under Company');
  assert.equal(getWorkflow(company, zed).id, company, 'opened by id');
  assert.throws(() => updateWorkflow(company, zed, { title: 'Hijacked' }), (e: { status?: number }) => e.status === 403, 'cannot edit');
  assert.ok(!all.has(domainOnly), 'Domain twin NOT listed');
  assert.throws(() => getWorkflow(domainOnly, zed), 'Domain twin NOT openable');
});

test('Company knowledge note from sales: a finance member lists, gets and RETRIEVES it, cannot edit it; Domain twin hidden', () => {
  const company = seedPk(2);
  const domainOnly = seedPk(1);
  const g = listPersonalKnowledge(zed, { activeDomain: 'finance' });
  assert.ok(g.marketplace.some((s) => s.id === company), 'listed under Company');
  assert.equal(getPersonalKnowledge(company, zed).id, company, 'opened by id');
  assert.throws(() => updatePersonalKnowledge(company, zed, { title: 'Hijacked' }), (e: { status?: number }) => e.status === 403, 'cannot edit');
  assert.ok(![...g.mine, ...g.domain, ...g.marketplace].some((s) => s.id === domainOnly), 'Domain twin NOT listed');
  assert.throws(() => getPersonalKnowledge(domainOnly, zed), 'Domain twin NOT openable');
  // Agent / search_knowledge retrieval DLS (retrieve-core canSee).
  const prov = (visibility: string) => ({ owner: 'u1', domain: 'sales', visibility, type: 'note' }) as unknown as Parameters<typeof canSee>[0];
  assert.equal(canSee(prov('Marketplace'), zed), true, 'retrieval admits Company');
  assert.equal(canSee(prov('Shared'), zed), false, 'retrieval refuses the Domain twin');
});

// The MCP front door (the same list_*/get_* tools an agent run calls), as a member of ANOTHER domain.
async function mcpCall(user: { id: string; name?: string; domains: string[]; role: string }, name: string, args: Record<string, unknown> = {}) {
  const { handleRpc } = await import('@core/mcp/server');
  const res = await handleRpc({ name: user.id, ...user } as Parameters<typeof handleRpc>[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = (res as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, text: r.content[0].text };
}

test('MCP: list_knowledge + get_knowledge show the Company note to a finance member; Domain twin hidden', async () => {
  const co = seedPk(2);
  const dom = seedPk(1);
  const list = await mcpCall(zed, 'list_knowledge');
  assert.ok(list.text.includes(co), 'Company note listed');
  assert.ok(!list.text.includes(dom), 'Domain twin not listed');
  assert.equal((await mcpCall(zed, 'get_knowledge', { id: co })).isError, false);
  assert.equal((await mcpCall(zed, 'get_knowledge', { id: dom })).isError, true);
});

test('MCP: list_workflows shows the Company workflow to a finance member; Domain twin hidden', async () => {
  const co = seedWf(2);
  const dom = seedWf(1);
  const list = await mcpCall(zed, 'list_workflows');
  assert.ok(list.text.includes(co), 'Company workflow listed');
  assert.ok(!list.text.includes(dom), 'Domain twin not listed');
});
