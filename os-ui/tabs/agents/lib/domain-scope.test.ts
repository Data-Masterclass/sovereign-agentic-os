/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/agents/store.ts → listSystems + agentHealthRows.
 *
 * THE RULE:
 *  1. GROUP BY VISIBILITY, not ownership — an owned Shared system belongs under
 *     "Domain" (not "My"), an owned Marketplace system under "Company" (marketplace).
 *  2. My and Domain narrow to the ACTIVE domain — a system created in domain A is
 *     hidden when domain B is active, shown when A is active, shown under "All
 *     Domains". Applies to the owner + admin (no bypass). A COMPANY (Marketplace)
 *     system is visible in EVERY domain (owner decision 2026-11-23,
 *     core/kernel/company-scope).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetStore,
  createSystem,
  promoteSystem,
  listSystems,
  getSystem,
  renameAgentSystem,
  agentHealthRows,
  type Principal,
} from '@tabs/agents/lib/store';

// One user (b1) who belongs to BOTH sales + finance. auth.ts narrows user.domains
// to the ACTIVE domain, so we model "acting in sales" as domains:['sales'], etc.
const b1All: Principal = { id: 'b1', domains: ['sales', 'finance'], role: 'admin' };
const b1Sales: Principal = { id: 'b1', domains: ['sales'], role: 'admin' };
const b1Finance: Principal = { id: 'b1', domains: ['finance'], role: 'admin' };

beforeEach(() => __resetStore());

test('an owned SHARED system groups under Domain, not My', () => {
  const sys = createSystem(b1All, { name: 'Shared Desk', domain: 'sales' });
  promoteSystem(sys.id, b1All); // Personal → Shared
  const g = listSystems(b1Sales);
  assert.ok(!g.mine.some((s) => s.id === sys.id), 'owned Shared system must NOT be under My');
  assert.ok(g.domain.some((s) => s.id === sys.id), 'owned Shared system must be under Domain');
});

test('an owned CERTIFIED (Marketplace) system groups under Company, not My', () => {
  const sys = createSystem(b1All, { name: 'Company Desk', domain: 'sales' });
  promoteSystem(sys.id, b1All); // → Shared
  promoteSystem(sys.id, b1All); // → Marketplace
  const g = listSystems(b1Sales);
  assert.ok(!g.mine.some((s) => s.id === sys.id), 'owned Marketplace system must NOT be under My');
  assert.ok(g.marketplace.some((s) => s.id === sys.id), 'owned Marketplace system must be under Company');
});

for (const [tier, promote] of [
  ['My (Personal)', 0],
  ['Domain (Shared)', 1],
  ['Company (Marketplace)', 2],
] as const) {
  test(`${tier} system in domain A: ${promote === 2 ? 'SHOWN' : 'hidden'} in B, shown in A, shown under All Domains`, () => {
    const sys = createSystem(b1All, { name: `${tier} sales`, domain: 'sales' });
    for (let i = 0; i < promote; i++) promoteSystem(sys.id, b1All);

    const inB = listSystems(b1Finance);
    const inBHas = [...inB.mine, ...inB.domain, ...inB.marketplace].some((s) => s.id === sys.id);
    if (promote === 2) assert.ok(inBHas, `${tier} sales system must be VISIBLE in every domain (Company scope)`);
    else assert.ok(!inBHas, `${tier} sales system must be HIDDEN when active domain is finance`);

    const inA = listSystems(b1Sales);
    assert.ok([...inA.mine, ...inA.domain, ...inA.marketplace].some((s) => s.id === sys.id),
      `${tier} sales system must be SHOWN when active domain is sales`);

    const all = listSystems(b1All);
    assert.ok([...all.mine, ...all.domain, ...all.marketplace].some((s) => s.id === sys.id),
      `${tier} sales system must be SHOWN under All Domains`);
  });
}

test('agentHealthRows mirrors listSystems: Shared→domain scope + active-domain isolation', () => {
  const sys = createSystem(b1All, { name: 'Shared Desk', domain: 'sales' });
  promoteSystem(sys.id, b1All); // Shared

  const rowSales = agentHealthRows(b1Sales).find((r) => r.id === sys.id);
  assert.ok(rowSales && rowSales.scope === 'domain', 'owned Shared health row is scope=domain, not mine');

  assert.ok(!agentHealthRows(b1Finance).some((r) => r.id === sys.id),
    'health row for a sales-domain system is hidden when active domain is finance');
});

// ------------------------------------------------ Company scope: a member of ANOTHER domain --
// Owner decision 2026-11-23 (core/kernel/company-scope): a Company item from domain A is visible
// to every signed-in member of domain B — listed and opened by id — but NOT editable by them.
// Negative twin: a Domain-scope item from A stays invisible to B.

const zed: Principal = { id: 'zed', domains: ['finance'], role: 'creator' };

test('Company agent system from sales: a finance member lists + gets it, cannot edit it; Domain twin hidden', () => {
  const company = createSystem(b1All, { name: 'Company Desk', domain: 'sales' });
  promoteSystem(company.id, b1All); promoteSystem(company.id, b1All); // → Marketplace
  const domainOnly = createSystem(b1All, { name: 'Sales Desk', domain: 'sales' });
  promoteSystem(domainOnly.id, b1All); // → Shared
  const g = listSystems(zed);
  assert.ok(g.marketplace.some((s) => s.id === company.id), 'listed under Company');
  assert.equal(getSystem(company.id, zed).id, company.id, 'opened by id');
  assert.throws(() => renameAgentSystem(company.id, zed, 'Hijacked'), 'cannot edit');
  assert.ok(![...g.mine, ...g.domain, ...g.marketplace].some((s) => s.id === domainOnly.id), 'Domain twin NOT listed');
  assert.throws(() => getSystem(domainOnly.id, zed), 'Domain twin NOT openable');
});

// The MCP front door (the same list_*/get_* tools an agent run calls), as a member of ANOTHER domain.
async function mcpCall(user: { id: string; name?: string; domains: string[]; role: string }, name: string, args: Record<string, unknown> = {}) {
  const { handleRpc } = await import('@core/mcp/server');
  const res = await handleRpc({ name: user.id, ...user } as Parameters<typeof handleRpc>[0], { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = (res as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: r.isError === true, text: r.content[0].text };
}

test('MCP: list_agent_systems + get_agent_system show the Company system to a finance member; Domain twin hidden', async () => {
  const co = createSystem(b1All, { name: 'Company Desk MCP', domain: 'sales' });
  promoteSystem(co.id, b1All); promoteSystem(co.id, b1All);
  const dom = createSystem(b1All, { name: 'Sales Desk MCP', domain: 'sales' });
  promoteSystem(dom.id, b1All);
  const list = await mcpCall(zed, 'list_agent_systems');
  assert.ok(list.text.includes(co.id), 'Company system listed');
  assert.ok(!list.text.includes(dom.id), 'Domain twin not listed');
  assert.equal((await mcpCall(zed, 'get_agent_system', { systemId: co.id })).isError, false);
  assert.equal((await mcpCall(zed, 'get_agent_system', { systemId: dom.id })).isError, true);
});
