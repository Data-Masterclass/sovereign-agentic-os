/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/agents/store.ts → listSystems + agentHealthRows.
 *
 * THE RULE:
 *  1. GROUP BY VISIBILITY, not ownership — an owned Shared system belongs under
 *     "Domain" (not "My"), an owned Marketplace system under "Company" (marketplace).
 *  2. EVERY tier (My / Domain / Company) narrows to the ACTIVE domain — a system
 *     created in domain A is hidden when domain B is active, shown when A is active,
 *     shown under "All Domains". Applies to the owner + admin (no bypass).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetStore,
  createSystem,
  promoteSystem,
  listSystems,
  agentHealthRows,
  type Principal,
} from './store.ts';

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
  test(`${tier} system in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const sys = createSystem(b1All, { name: `${tier} sales`, domain: 'sales' });
    for (let i = 0; i < promote; i++) promoteSystem(sys.id, b1All);

    const inB = listSystems(b1Finance);
    assert.ok(![...inB.mine, ...inB.domain, ...inB.marketplace].some((s) => s.id === sys.id),
      `${tier} sales system must be HIDDEN when active domain is finance`);

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
