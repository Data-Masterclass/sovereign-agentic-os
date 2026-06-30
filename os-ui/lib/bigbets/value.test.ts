/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realizedValue, distribute, pillarRollup } from './value.ts';
import { buildComposition } from './composition.ts';
import { __resetSources, __resetStrategy, __seedStrategy, sourceFor } from './sources.ts';
import { type Actor, type BigBet } from './model.ts';

const builder: Actor = { id: 'sara', domains: ['sales'], role: 'builder', kind: 'human' };

// The strategy up-link ships EMPTY now; tests inject the NRR metric fixture the
// retention bet measures against (RLS: sara sees the full slice, kenji less).
function seedNrr(): void {
  __seedStrategy(
    {
      id: 'metric_nrr',
      name: 'Net Revenue Retention',
      cubeMeasure: 'mart_retention.nrr_eur',
      unit: '€',
      baseline: 1_200_000,
      current: 1_560_000,
      rls: { sara: 1_560_000, kenji: 980_000 },
    },
    { id: 'pillar_retention', name: 'Retention', scope: 'tenant', metricId: 'metric_nrr' },
  );
}

function churnBet(over: Partial<BigBet> = {}): BigBet {
  return {
    id: 'bet_churn',
    name: 'Reduce churn',
    problem: { who: 'Sales', need: 'keep at-risk accounts', obstacle: 'no early signal', impact: '€360k/yr lost' },
    domain: 'sales',
    crossDomain: false,
    owner: 'sara',
    members: ['sara'],
    pillarId: 'pillar_retention',
    metricId: 'metric_nrr',
    targetValue: 400_000,
    valueBasis: 'uplift',
    allocation: 'manual',
    goLive: '2026-09-01',
    status: 'active',
    components: [],
    createdBy: 'sara',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

test('realized value follows the selectable basis (uplift default, absolute, owner-declared)', () => {
  __resetStrategy();
  seedNrr();
  const uplift = realizedValue(churnBet({ valueBasis: 'uplift' }), 'sara');
  assert.equal(uplift.realized, 360_000); // 1.56M current − 1.2M baseline

  const absolute = realizedValue(churnBet({ valueBasis: 'absolute' }), 'sara');
  assert.equal(absolute.realized, 1_560_000);
  assert.notEqual(uplift.realized, absolute.realized);

  const declared = realizedValue(churnBet({ valueBasis: 'owner-declared', ownerDeclaredValue: 300_000 }), 'sara');
  assert.equal(declared.realized, 300_000);
  assert.ok(declared.corroboration && declared.corroboration.metric === 360_000);
});

test('value is RLS-scoped — two viewers see their own governed slice', () => {
  __resetStrategy();
  seedNrr();
  const sara = realizedValue(churnBet({ valueBasis: 'absolute' }), 'sara');
  const kenji = realizedValue(churnBet({ valueBasis: 'absolute' }), 'kenji');
  assert.equal(sara.realized, 1_560_000);
  assert.equal(kenji.realized, 980_000); // RLS slice, not a side channel
});

test('distribution reconciles, and switching manual→usage changes shares while data earns upstream credit', () => {
  __resetSources();
  __resetStrategy();
  const data = sourceFor('data').scaffold({ title: 'Churn data', domain: 'sales', bigBetId: 'bet_churn', by: builder });
  const model = sourceFor('ml').scaffold({ title: 'Churn model', domain: 'sales', bigBetId: 'bet_churn', by: builder, consumes: [data.id] });
  const dash = sourceFor('dashboard').scaffold({ title: 'Churn dash', domain: 'sales', bigBetId: 'bet_churn', by: builder, consumes: [model.id] });
  const agent = sourceFor('agent').scaffold({ title: 'Retention agent', domain: 'sales', bigBetId: 'bet_churn', by: builder, consumes: [model.id] });
  // give the dashboard heavy usage so usage-based shifts mass to it.
  sourceFor('dashboard').advance(dash.id, 'published', builder);
  dash.usage30d = 500;
  agent.usage30d = 50;

  const refs = [
    { refId: 'r_data', artifactId: data.id },
    { refId: 'r_model', artifactId: model.id },
    { refId: 'r_dash', artifactId: dash.id },
    { refId: 'r_agent', artifactId: agent.id },
  ];
  const weights = new Map([['r_data', 10], ['r_model', 30], ['r_dash', 40], ['r_agent', 20]]);
  const comp = buildComposition(refs.map((r) => r.artifactId));
  const betValue = 360_000;

  const manual = distribute(betValue, refs, weights, 'manual', comp);
  assert.ok(manual.reconciles, `manual must reconcile (residual ${manual.residual})`);
  const dataManual = manual.components.find((c) => c.artifactId === data.id)!;
  assert.ok(dataManual.upstreamCredit > 0, 'data earns upstream credit because the model builds on it');

  const usage = distribute(betValue, refs, weights, 'usage', comp);
  assert.ok(usage.reconciles, `usage must reconcile (residual ${usage.residual})`);
  const dashManual = manual.components.find((c) => c.artifactId === dash.id)!.value;
  const dashUsage = usage.components.find((c) => c.artifactId === dash.id)!.value;
  assert.notEqual(dashManual, dashUsage, 'switching allocation changes shares');

  const equal = distribute(betValue, refs, weights, 'equal', comp);
  assert.ok(equal.reconciles, `equal must reconcile (residual ${equal.residual})`);
});

test('pillar roll-up = Σ bet realized, and per-bet shares reconcile back', () => {
  const roll = pillarRollup([
    { bet: churnBet({ id: 'b1' }), realized: 360_000 },
    { bet: churnBet({ id: 'b2', name: 'Win-back' }), realized: 140_000 },
  ]);
  assert.equal(roll.total, 500_000);
  assert.equal(roll.perBet.reduce((a, b) => a + b.realized, 0), 500_000);
  assert.equal(roll.perBet.find((b) => b.id === 'b1')!.sharePct, 72);
});
