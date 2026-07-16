/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { domainPulseStub, healthCostStub } from './stubs.ts';
import { createBet, __resetBets } from '@/lib/bigbets';
import { setCap, addSpend, __resetCost } from '@/lib/governance';
import type { BigBet } from '@/lib/bigbets';
import type { Pillar } from '@/lib/strategy';

// ── Contract: fresh tenant shows real 0s, source is 'live' ────────────────────

test('live feeds are marked source: "live" (not mock)', async () => {
  const p = await domainPulseStub('sales', { pillars: [], bets: [] });
  assert.equal(p.source, 'live');
  const h = healthCostStub('amir', 'sales');
  assert.equal(h.source, 'live');
});

test('no-drift: same inputs → identical output', async () => {
  const p1 = await domainPulseStub('sales', { pillars: [], bets: [] });
  const p2 = await domainPulseStub('sales', { pillars: [], bets: [] });
  assert.deepEqual(p1, p2);
  const h1 = healthCostStub('amir', 'sales');
  const h2 = healthCostStub('amir', 'sales');
  assert.deepEqual(h1, h2);
});

test('a fresh tenant has an EMPTY cockpit — no fabricated activity', async () => {
  // No pillars, no bets → all-zero pulse is honest real state.
  const p = await domainPulseStub('sales', { pillars: [], bets: [] });
  assert.equal(p.valuePct, 0, 'valuePct should be 0 when no pillars with targets');
  assert.equal(p.bets.length, 0, 'bets should be empty when none seeded');
  // activeCreators counts real users: bootstrap admin is role=admin not creator → 0.
  assert.equal(p.activeCreators, 0);

  const h = healthCostStub('amir', 'sales');
  assert.equal(h.redItems.length, 0);
  assert.equal(h.spendUsd, 0);
  assert.equal(h.capUsd, 0);
});

test('pulse + health stay within sane bounds', async () => {
  const p = await domainPulseStub('sales', { pillars: [], bets: [] });
  assert.ok(p.valuePct >= 0, 'valuePct must be >= 0');
  const h = healthCostStub('amir', 'sales');
  assert.ok(h.spendUsd >= 0, 'spendUsd must be >= 0');
  assert.ok(h.capUsd >= 0, 'capUsd must be >= 0');
  assert.ok(h.spendPct >= 0 && h.spendPct <= 1, 'spendPct must be in [0, 1]');
});

// ── Real store data: pulse reflects a bet seeded in the Big Bets store ─────────

test('pulse.bets reflects a real bet seeded in the store', async () => {
  __resetBets();
  const admin = { id: 'u-pulse-test', domains: ['eng'], role: 'admin' as const };
  const bet = createBet(admin, {
    name: 'Launch feature X',
    problem: { what: 'slow onboarding', why: 'reduces activation' },
    pillarId: 'pillar_eng_growth',
    targetValue: 100_000,
    goLive: '2026-12-31',
    domain: 'eng',
  });

  // Pass the created bet directly — same path feed.ts uses after listBets(user).
  const p = await domainPulseStub('eng', { pillars: [], bets: [bet] });
  assert.equal(p.bets.length, 1, 'one bet should appear in the pulse');
  assert.equal(p.bets[0].name, 'Launch feature X');
  // An active bet (no components) maps to on-track, pct=0 (no components done).
  assert.equal(p.bets[0].status, 'on-track');
  assert.equal(p.bets[0].pct, 0);

  __resetBets();
});

test('pulse ignores archived bets', async () => {
  __resetBets();
  const admin = { id: 'u-archived-test', domains: ['mkt'], role: 'admin' as const };
  const bet = createBet(admin, {
    name: 'Old campaign',
    problem: { what: 'low awareness', why: 'missing reach' },
    pillarId: 'pillar_mkt_growth',
    targetValue: 50_000,
    goLive: '2026-06-01',
    domain: 'mkt',
  });
  // Archive the bet.
  const { updateBet } = await import('@/lib/bigbets/store');
  const archived = updateBet(bet.id, admin, { status: 'archived' });

  const p = await domainPulseStub('mkt', { pillars: [], bets: [archived] });
  assert.equal(p.bets.length, 0, 'archived bets must not appear in the pulse');

  __resetBets();
});

test('pulse.bets: draft bet maps to status "planned"', async () => {
  __resetBets();
  const creator = { id: 'u-draft-test', domains: ['eng'], role: 'creator' as const };
  const bet = createBet(creator, {
    name: 'Draft idea',
    problem: { what: 'unclear', why: 'TBD' },
    pillarId: 'pillar_eng_ideas',
    targetValue: 0,
    goLive: '2027-01-01',
    domain: 'eng',
  });
  assert.equal(bet.status, 'draft');

  const p = await domainPulseStub('eng', { pillars: [], bets: [bet] });
  assert.equal(p.bets.length, 1);
  assert.equal(p.bets[0].status, 'planned');

  __resetBets();
});

// ── Real store data: health reflects a cap + spend set in governance ───────────

test('health.capUsd and health.spendUsd reflect a real domain cap + spend', () => {
  __resetCost();
  setCap({ scope: 'domain', subject: 'eng', limit: 500, period: 'month', createdBy: 'admin' });
  addSpend('domain', 'eng', 120);

  const h = healthCostStub('', 'eng');
  assert.equal(h.capUsd, 500, 'capUsd must equal the set limit');
  assert.equal(h.spendUsd, 120, 'spendUsd must equal the recorded spend');
  assert.ok(Math.abs(h.spendPct - 0.24) < 0.001, 'spendPct must be spend / cap');
  assert.equal(h.source, 'live');

  __resetCost();
});

test('health falls back to tenant cap when no domain cap is set', () => {
  __resetCost();
  setCap({ scope: 'tenant', subject: 'tenant', limit: 2000, period: 'month', createdBy: 'admin' });
  addSpend('tenant', 'tenant', 400);

  // Domain 'sales' has no explicit cap → should show tenant cap.
  const h = healthCostStub('', 'sales');
  assert.equal(h.capUsd, 2000, 'should fall back to tenant cap');
  assert.equal(h.spendUsd, 400, 'should show tenant spend');
  assert.ok(Math.abs(h.spendPct - 0.2) < 0.001);

  __resetCost();
});

test('health: domain cap takes precedence over tenant cap', () => {
  __resetCost();
  setCap({ scope: 'tenant', subject: 'tenant', limit: 2000, period: 'month', createdBy: 'admin' });
  setCap({ scope: 'domain', subject: 'eng', limit: 300, period: 'month', createdBy: 'admin' });
  addSpend('domain', 'eng', 60);
  addSpend('tenant', 'tenant', 500);

  const h = healthCostStub('', 'eng');
  assert.equal(h.capUsd, 300, 'domain cap should win over tenant cap');
  assert.equal(h.spendUsd, 60, 'should show domain spend, not tenant spend');

  __resetCost();
});

// ── valuePct: pulse reflects a pillar with a target and manual value ───────────

test('pulse.valuePct is computed from pillar targets and actual values', async () => {
  const pillarWithTarget: Pillar = {
    id: 'p1',
    name: 'Growth',
    description: '',
    scope: 'domain',
    domain: 'eng',
    owner: 'admin',
    metrics: [],
    valueMetric: {
      name: 'Revenue',
      description: '',
      mode: 'manual',
      entries: [{ month: '2026-06', value: 250_000, at: '', by: 'admin' }],
    },
    betIds: [],
    targets: {
      valueGenerated: { annual: 500_000, quarterly: { q1: 125_000, q2: 125_000, q3: 125_000, q4: 125_000 } },
      activeCreators: { annual: 5, quarterly: { q1: 1, q2: 1, q3: 1, q4: 2 } },
      activeBuilders: { annual: 2, quarterly: { q1: 0, q2: 1, q3: 1, q4: 0 } },
      certified: {
        data: { annual: 0, quarterly: { q1: 0, q2: 0, q3: 0, q4: 0 } },
        metric: { annual: 0, quarterly: { q1: 0, q2: 0, q3: 0, q4: 0 } },
        dashboard: { annual: 0, quarterly: { q1: 0, q2: 0, q3: 0, q4: 0 } },
        agent: { annual: 0, quarterly: { q1: 0, q2: 0, q3: 0, q4: 0 } },
        software: { annual: 0, quarterly: { q1: 0, q2: 0, q3: 0, q4: 0 } },
        ml: { annual: 0, quarterly: { q1: 0, q2: 0, q3: 0, q4: 0 } },
      },
    },
    createdAt: '',
    updatedAt: '',
  };

  const p = await domainPulseStub('eng', { pillars: [pillarWithTarget], bets: [] });
  // 250k actual / 500k target = 50%
  assert.equal(p.valuePct, 50, 'valuePct should be 50% for half of annual target met');
});
