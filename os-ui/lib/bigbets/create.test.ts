/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The reworked create-form shape: a derived name (no separate name field), an
 * Owner carried on `problem.who`, a single problem statement on `problem.need`,
 * a free-form `solution`, and an `archived` status for the Archive action.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBetName } from './model.ts';
import { createBet, updateBet, getBet, __resetBets } from './store.ts';
import type { Principal } from './model.ts';

const sara: Principal = { id: 'sara', domains: ['sales'], role: 'builder' };

test('deriveBetName takes the first sentence/line and caps length', () => {
  assert.equal(deriveBetName('Reduce churn in DACH. Then expand.'), 'Reduce churn in DACH');
  assert.equal(deriveBetName('Win back lapsed customers\nmore detail'), 'Win back lapsed customers');
  assert.equal(deriveBetName('   '), 'Untitled big bet');
  const long = 'a'.repeat(120);
  assert.ok(deriveBetName(long).length <= 70);
  assert.ok(deriveBetName(long).endsWith('…'));
});

test('createBet stores the owner, problem statement and solution; name is given', () => {
  __resetBets();
  const bet = createBet(sara, {
    name: deriveBetName('Cut at-risk account churn'),
    problem: { who: 'Retention team', need: 'Cut at-risk account churn', obstacle: '', impact: '' },
    solution: 'A churn model feeding a retention agent',
    pillarId: 'pillar_retention',
    metricId: 'metric_nrr',
    targetValue: 1_200_000,
    goLive: '2026-09-30',
  });
  assert.equal(bet.name, 'Cut at-risk account churn');
  assert.equal(bet.problem.who, 'Retention team'); // owner
  assert.equal(bet.problem.need, 'Cut at-risk account churn');
  assert.equal(bet.solution, 'A churn model feeding a retention agent');
  assert.equal(bet.status, 'active');
});

test('updateBet archives a bet (the Archive action)', () => {
  __resetBets();
  const bet = createBet(sara, {
    name: 'X', problem: { who: 'o', need: 'p', obstacle: '', impact: '' },
    pillarId: 'pillar_retention', metricId: 'metric_nrr', targetValue: 1, goLive: '2026-09-01',
  });
  updateBet(bet.id, sara, { status: 'archived' });
  assert.equal(getBet(bet.id, sara).status, 'archived');
});
