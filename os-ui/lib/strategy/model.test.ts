/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distributeValue,
  reconciles,
  entitledToDomain,
  canEditPillar,
  canViewPillar,
  canCreatePillar,
  trendFor,
  currentQuarter,
  monthKey,
  emptyTargetSet,
  euro,
  type DistributableBet,
} from './model.ts';

// The worked-example "Retention" decomposition: a €600k realized total split
// 60/40 across two bets in different domains.
const BETS: DistributableBet[] = [
  {
    id: 'b_churn',
    name: 'Reduce churn',
    domain: 'sales',
    sharePct: 0.6,
    components: [
      { id: 'c1', name: 'Churn data product', kind: 'data', weight: 0.25 },
      { id: 'c2', name: 'Churn model', kind: 'ml', weight: 0.35 },
      { id: 'c3', name: 'Churn dashboard', kind: 'dashboard', weight: 0.2 },
      { id: 'c4', name: 'Retention agent', kind: 'agent', weight: 0.2 },
    ],
  },
  {
    id: 'b_winback',
    name: 'Win-back',
    domain: 'marketing',
    sharePct: 0.4,
    components: [
      { id: 'c5', name: 'Lapsed data product', kind: 'data', weight: 0.5 },
      { id: 'c6', name: 'Win-back dashboard', kind: 'dashboard', weight: 0.5 },
    ],
  },
];

const TOTAL = 600_000;

test('distribution reconciles: Σ bet values === pillar total', () => {
  const admin = { domains: ['platform'], role: 'admin' as const };
  const d = distributeValue(TOTAL, BETS, admin);
  assert.equal(d.decomposedTotal, TOTAL);
  assert.equal(d.reconciled, true);
  // Per-bet split.
  assert.equal(d.bets[0].value, 360_000);
  assert.equal(d.bets[1].value, 240_000);
  // Components sum back to their bet.
  const churnSum = d.bets[0].components.reduce((a, c) => a + (c.value ?? 0), 0);
  assert.equal(churnSum, 360_000);
});

test('RLS: a Sales viewer sees only the sales bet; the marketing bet is masked', () => {
  const sales = { domains: ['sales'], role: 'builder' as const };
  const d = distributeValue(TOTAL, BETS, sales);
  // Reconciliation still holds on the FULL decomposition.
  assert.equal(d.reconciled, true);
  assert.equal(d.decomposedTotal, TOTAL);
  // But the viewer only SEES the entitled sales bet.
  assert.equal(d.bets[0].entitled, true);
  assert.equal(d.bets[0].value, 360_000);
  assert.equal(d.bets[1].entitled, false);
  assert.equal(d.bets[1].value, null);
  assert.equal(d.bets[1].components.every((c) => c.value === null), true);
  assert.equal(d.visibleTotal, 360_000);
  assert.equal(d.maskedTotal, 240_000);
  // The share is masked too — else total × sharePct recovers the hidden value.
  assert.equal(d.bets[1].sharePct, null);
  assert.equal(d.bets[0].sharePct, 0.6);
});

test('component values sum EXACTLY to the bet (rounding remainder absorbed)', () => {
  const admin = { domains: ['platform'], role: 'admin' as const };
  // €10 split three ways (1/3 each) — naive rounding would give 3+3+3=9.
  const bets: DistributableBet[] = [
    {
      id: 'b',
      name: 'thirds',
      domain: 'tenant',
      sharePct: 1,
      components: [
        { id: 'x', name: 'x', kind: 'data', weight: 1 / 3 },
        { id: 'y', name: 'y', kind: 'agent', weight: 1 / 3 },
        { id: 'z', name: 'z', kind: 'ml', weight: 1 / 3 },
      ],
    },
  ];
  const d = distributeValue(10, bets, admin);
  const sum = d.bets[0].components.reduce((a, c) => a + (c.value ?? 0), 0);
  assert.equal(sum, 10); // exact, not 9
});

test('RLS: two viewers of the same pillar see different, correctly-scoped totals', () => {
  const sales = { domains: ['sales'], role: 'builder' as const };
  const marketing = { domains: ['marketing'], role: 'builder' as const };
  const ds = distributeValue(TOTAL, BETS, sales);
  const dm = distributeValue(TOTAL, BETS, marketing);
  assert.equal(ds.visibleTotal, 360_000);
  assert.equal(dm.visibleTotal, 240_000);
  // Same governed total underneath, no privileged side-channel.
  assert.equal(ds.decomposedTotal, dm.decomposedTotal);
});

test('entitledToDomain: tenant is public; platform admin is tenant-wide', () => {
  const sales = { domains: ['sales'], role: 'participant' as const };
  assert.equal(entitledToDomain(sales, 'tenant'), true);
  assert.equal(entitledToDomain(sales, 'sales'), true);
  assert.equal(entitledToDomain(sales, 'marketing'), false);
  const admin = { domains: ['platform'], role: 'admin' as const };
  assert.equal(entitledToDomain(admin, 'marketing'), true);
});

test('reconciles tolerates integer-cent rounding but rejects real drift', () => {
  assert.equal(reconciles(599_999, 600_000), true);
  assert.equal(reconciles(596_000, 600_000), false);
});

test('role gate: Creators view but cannot edit; Builder edits own domain; Admin owns tenant', () => {
  const tenantPillar = { scope: 'tenant' as const, domain: 'tenant' };
  const salesPillar = { scope: 'domain' as const, domain: 'sales' };
  const creator = { domains: ['sales'], role: 'participant' as const };
  const builder = { domains: ['sales'], role: 'builder' as const };
  const admin = { domains: ['platform', 'sales'], role: 'admin' as const };

  // Creators/Users: view everything in scope, edit nothing.
  assert.equal(canViewPillar(creator, tenantPillar), true);
  assert.equal(canEditPillar(creator, tenantPillar), false);
  assert.equal(canEditPillar(creator, salesPillar), false);

  // Builder: edits their domain pillar, NOT the tenant pillar.
  assert.equal(canEditPillar(builder, salesPillar), true);
  assert.equal(canEditPillar(builder, tenantPillar), false);
  assert.equal(canCreatePillar(builder, 'domain', 'sales'), true);
  assert.equal(canCreatePillar(builder, 'tenant', 'tenant'), false);

  // Admin: owns the tenant pillar + their domains.
  assert.equal(canEditPillar(admin, tenantPillar), true);
  assert.equal(canEditPillar(admin, salesPillar), true);

  // A builder outside the domain cannot edit it.
  const otherBuilder = { domains: ['finance'], role: 'builder' as const };
  assert.equal(canEditPillar(otherBuilder, salesPillar), false);
});

test('trendFor paces actual against the elapsed year with a tolerance band', () => {
  // Half a year in, target 100 → expected 50; 48 is within the 5% band.
  assert.equal(trendFor(48, 100, 0.5), 'on-track');
  assert.equal(trendFor(40, 100, 0.5), 'behind');
  assert.equal(trendFor(0, 0, 0.5), 'no-target');
});

test('currentQuarter + monthKey produce stable keys', () => {
  assert.equal(currentQuarter(new Date('2026-02-15T00:00:00Z')), 'q1');
  assert.equal(currentQuarter(new Date('2026-11-15T00:00:00Z')), 'q4');
  assert.equal(monthKey(new Date('2026-06-09T00:00:00Z')), '2026-06');
});

test('emptyTargetSet spreads an annual value across four quarters', () => {
  const t = emptyTargetSet();
  assert.equal(t.valueGenerated.annual, 0);
  assert.equal(Object.keys(t.certified).length, 6);
});

test('euro formats compactly', () => {
  assert.equal(euro(600_000), '€600k');
  assert.equal(euro(2_400_000), '€2.4M');
  assert.equal(euro(null), '—');
});
