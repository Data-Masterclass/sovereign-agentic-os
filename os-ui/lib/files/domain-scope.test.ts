/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Strict domain-isolation tests for lib/files/store.ts → listFiles.
 * Every tier (My/Domain/Company) narrows to the active domain; the fixed leak is
 * that canRead returns true for the OWNER regardless of domain, so an owner's
 * domain-A asset/product used to leak into Domain/Company while acting in domain B.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetStore, createFile, transition, listFiles, type Principal } from './store.ts';

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
  test(`${label} file in domain A: hidden in B, shown in A, shown under All Domains`, () => {
    const id = seedSales(tier);
    assert.ok(!allIds(uFinance).has(id), `${label} sales file HIDDEN in finance`);
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
