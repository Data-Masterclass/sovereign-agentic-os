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
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetStore, createDataset, buildVersion, transition, listAskable, listDatasets, type Principal } from './store.ts';

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
  test(`${label} dataset in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const id = seedSales(tier);
    assert.ok(!allIds(uFinance).has(id), `${label} sales dataset HIDDEN when active domain is finance`);
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
  test(`Talk-to-Data evidence (listAskable): ${label} sales dataset never cited under another active domain`, () => {
    const id = seedSales(tier);
    const askable = (u: Principal) => new Set(listAskable(u).map((d) => d.id));
    assert.ok(!askable(uFinance).has(id), `${label} sales dataset NOT askable when finance is active`);
    assert.ok(askable(uSales).has(id), `${label} sales dataset askable when sales is active`);
    assert.ok(askable(uAll).has(id), `${label} sales dataset askable under All Domains`);
  });
}
