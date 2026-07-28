/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/knowledge/store.ts → listWorkflows AND
 * lib/knowledge/personal-store.ts → listPersonalKnowledge. Every tier narrows to the
 * active domain; an owned Shared workflow groups under Domain, an owned Marketplace one
 * under Company. Cross-domain discovery is the Marketplace catalog's job, not these lists.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetStore as resetWf,
  createWorkflow,
  publishWorkflow,
  certifyWorkflow,
  listWorkflows,
  type Principal as WfPrincipal,
} from './store.ts';
import {
  __resetStore as resetPk,
  createPersonalKnowledge,
  promotePersonalKnowledge,
  certifyPersonalKnowledge,
  listPersonalKnowledge,
} from './personal-store.ts';

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
  test(`workflow ${label} in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const id = seedWf(tier);
    assert.ok(!wfIds(uFinance).all.has(id), `${label} sales workflow HIDDEN in finance`);
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
  test(`personal-knowledge ${label} in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const id = seedPk(tier);
    assert.ok(!pkIds('finance').all.has(id), `${label} sales entry HIDDEN when active domain is finance`);
    assert.ok(pkIds('sales').all.has(id), `${label} sales entry SHOWN when active domain is sales`);
    assert.ok(pkIds(null).all.has(id), `${label} sales entry SHOWN under All Domains`);
  });
}
