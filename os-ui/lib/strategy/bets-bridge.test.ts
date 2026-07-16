/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tier-1 consolidation test: Strategy's "link a bet" catalogue + pillar roll-up read
 * REAL bets from the Big Bets store (not just the 3 seed stubs), scoped by canView.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { betCatalogue, defaultBetShareSource } from './bets-bridge.ts';
import { createBet, __resetBets } from '@/lib/bigbets/store';
import { __resetSources } from '@/lib/bigbets';
import type { Actor } from '@/lib/bigbets';

const owner: Actor = { id: 'owner', domains: ['sales'], role: 'builder', kind: 'human' };
const stranger = { id: 'stranger', domains: ['research'], role: 'creator' as const };
const admin = { id: 'root', domains: ['sales', 'research'], role: 'admin' as const };

function reset() {
  __resetBets();
  __resetSources();
}

test('catalogue: a REAL student-created bet appears, scoped by canView', () => {
  reset();
  const bet = createBet(owner, {
    name: 'Reduce churn',
    problem: { who: 'Sales', need: 'retain accounts', obstacle: 'no signal', impact: '€360k' },
    pillarId: 'pillar_sales_growth',
    targetValue: 400_000,
    goLive: '2026-09-01',
  });

  const forOwner = betCatalogue(owner);
  assert.ok(forOwner.some((b) => b.id === bet.id && b.name === 'Reduce churn'), 'owner sees their real bet');

  const forStranger = betCatalogue(stranger);
  assert.equal(forStranger.some((b) => b.id === bet.id), false, 'a research-domain non-member does not see a sales bet');

  assert.ok(betCatalogue(admin).some((b) => b.id === bet.id), 'admin sees every bet');
});

test('roll-up: forPillar returns REAL bets tagged to the pillar', async () => {
  reset();
  const bet = createBet(owner, {
    name: 'Win-back',
    problem: { who: 'Sales', need: 'win back lapsed', obstacle: 'no list', impact: '€120k' },
    pillarId: 'pillar_sales_growth',
    targetValue: 120_000,
    goLive: '2026-10-01',
  });

  const shares = await defaultBetShareSource.forPillar('pillar_sales_growth');
  assert.ok(shares.some((s) => s.id === bet.id), 'the real pillar-tagged bet flows into the roll-up');
  // Shares re-normalise so they reconcile (Σ sharePct === 1).
  const sum = shares.reduce((a, s) => a + s.sharePct, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'bet shares reconcile to 1');
});
