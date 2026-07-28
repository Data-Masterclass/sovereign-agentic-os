/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Active-domain scope tests for lib/bigbets/store.ts → listBets
 *
 * Rule: a bet owned by the caller in domain A must be hidden when domain B is
 * active, visible when A is active, and visible under "All Domains". Domain-
 * peer bets (where the caller is NOT the owner but is in the bet's domain) are
 * already narrowed by canView → user.domains.includes(bet.domain). Company /
 * cross-domain bets owned by an admin are not narrowed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBet, listBets, __resetBets } from './store.ts';
import { __resetSources } from './sources.ts';

function reset() {
  __resetBets();
  __resetSources();
}

// Pillars are required for createBet; we use a mock pillar id that passes the
// non-empty check without needing the real strategy store wired up.
const MOCK_PILLAR = 'pillar_test';

// Builder in both sales + finance (All Domains view).
const builderAll = { id: 'b1', name: 'B1', role: 'builder' as const, domains: ['sales', 'finance'] };
// Builder with active domain = sales only.
const builderSales = { id: 'b1', name: 'B1', role: 'builder' as const, domains: ['sales'] };
// Builder with active domain = finance only.
const builderFinance = { id: 'b1', name: 'B1', role: 'builder' as const, domains: ['finance'] };

test('owner bet in domain A is hidden when active domain is B', () => {
  reset();
  const bet = createBet(builderAll, {
    name: 'Sales Bet',
    problem: { who: 'sales', need: 'grow revenue', obstacle: '', impact: '' },
    targetValue: 100_000,
    goLive: '2026-12-31',
    pillarId: MOCK_PILLAR,
    domain: 'sales',
  });
  assert.equal(bet.domain, 'sales');

  // Active domain = finance → owner bet in sales must NOT appear.
  const visibleFinance = listBets(builderFinance);
  assert.ok(!visibleFinance.some((b) => b.id === bet.id), 'sales bet must be hidden when active domain is finance');
});

test('owner bet in domain A is shown when active domain is A', () => {
  reset();
  const bet = createBet(builderAll, {
    name: 'Sales Bet',
    problem: { who: 'sales', need: 'grow revenue', obstacle: '', impact: '' },
    targetValue: 100_000,
    goLive: '2026-12-31',
    pillarId: MOCK_PILLAR,
    domain: 'sales',
  });

  const visibleSales = listBets(builderSales);
  assert.ok(visibleSales.some((b) => b.id === bet.id), 'sales bet must be visible when active domain is sales');
});

test('owner bet in domain A is shown under All Domains', () => {
  reset();
  const bet = createBet(builderAll, {
    name: 'Sales Bet',
    problem: { who: 'sales', need: 'grow revenue', obstacle: '', impact: '' },
    targetValue: 100_000,
    goLive: '2026-12-31',
    pillarId: MOCK_PILLAR,
    domain: 'sales',
  });

  const visibleAll = listBets(builderAll);
  assert.ok(visibleAll.some((b) => b.id === bet.id), 'sales bet must be visible under All Domains');
});

test('admin sees all bets regardless of active domain', () => {
  reset();
  const adminAll = { id: 'admin', name: 'Admin', role: 'admin' as const, domains: ['platform'] };
  // A builder creates a bet in sales.
  const bet = createBet(builderAll, {
    name: 'Sales Bet',
    problem: { who: 'sales', need: 'grow revenue', obstacle: '', impact: '' },
    targetValue: 100_000,
    goLive: '2026-12-31',
    pillarId: MOCK_PILLAR,
    domain: 'sales',
  });

  // Admin (not in sales domain) must still see the bet.
  const visibleAdmin = listBets(adminAll);
  assert.ok(visibleAdmin.some((b) => b.id === bet.id), 'admin must see all bets regardless of domain');
});
