/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { ArtifactKind } from '@/lib/strategy/model';

/**
 * Pillar ↔ Big-Bet share interface — the CROSS-TAB seam with the Big Bets tab.
 *
 * Strategy owns the pillar + its business-value metric (the TOTAL). The Big Bets
 * tab owns each bet's *distribution*: what share of the pillar a bet realizes,
 * and how that bet distributes down to its components (the mechanics — selectable
 * allocation, upstream credit — live in `big-bets-golden-path.md`). Strategy only
 * needs the resulting shares to render the pillar-level roll-up + drill-down.
 *
 * Big Bets is on a parallel branch, so here we define the INTERFACE Strategy
 * consumes and a deterministic STUB source for `kind`. When the real Big Bets
 * registry lands, swap `defaultBetShareSource` for an adapter that reads bets
 * tagged to the pillar (`pillar_id`) + their value distribution — nothing else
 * in Strategy changes. The reconcile contract is fixed here:
 *
 *   Σ bet.sharePct  === 1            (bets sum to the pillar metric total)
 *   Σ component.weight === 1 per bet (components sum to the bet)
 */

/** A bet's contribution to its pillar (fractions of the pillar metric total). */
export type BetShare = {
  /** Big Bet id (the artifact the Big Bets tab owns). */
  id: string;
  /** Display name. */
  name: string;
  /** The bet's owning domain — drives RLS scoping in the roll-up. */
  domain: string;
  /** Fraction of the pillar metric total this bet realizes (0..1). */
  sharePct: number;
  /** Component breakdown; weights are fractions of the bet (sum to 1). */
  components: BetComponentShare[];
};

export type BetComponentShare = {
  id: string;
  name: string;
  kind: ArtifactKind;
  /** Fraction of the bet's value this component carries (0..1). */
  weight: number;
};

/** The source Strategy reads bet shares from (stub now, registry later). */
export interface BetShareSource {
  /** All bet shares contributing to a pillar, by pillar id. */
  forPillar(pillarId: string): Promise<BetShare[]>;
}

// ------------------------------------------------------------- Stub seed -------

/**
 * Deterministic stub: the worked-example "Retention" pillar's two Big Bets,
 * each distributed across real component kinds. Shares sum to 1 (reconcile),
 * component weights per bet sum to 1. The Win-back bet is owned by `marketing`
 * so the RLS proof has a domain a Sales viewer is NOT entitled to.
 */
const STUB: Record<string, BetShare[]> = {
  // Keyed by the seeded Retention pillar id (see pillars.ts seed()).
  seed_pillar_retention: [
    {
      id: 'seed_bet_reduce_churn',
      name: 'Reduce churn',
      domain: 'sales',
      sharePct: 0.6,
      components: [
        { id: 'seed_dp_churn', name: 'Churn data product', kind: 'data', weight: 0.25 },
        { id: 'seed_ml_churn', name: 'Churn model', kind: 'ml', weight: 0.35 },
        { id: 'seed_dash_churn', name: 'Churn Risk dashboard', kind: 'dashboard', weight: 0.2 },
        { id: 'seed_agent_retention', name: 'Sales retention agent', kind: 'agent', weight: 0.2 },
      ],
    },
    {
      id: 'seed_bet_winback',
      name: 'Win-back campaign',
      domain: 'marketing',
      sharePct: 0.4,
      components: [
        { id: 'seed_dp_winback', name: 'Lapsed-customer data product', kind: 'data', weight: 0.4 },
        { id: 'seed_dash_winback', name: 'Win-back dashboard', kind: 'dashboard', weight: 0.3 },
        { id: 'seed_agent_winback', name: 'Win-back outreach agent', kind: 'agent', weight: 0.3 },
      ],
    },
  ],
};

/**
 * Bet shares keyed dynamically: pillars created at runtime link bets by id via
 * `linkBetStub`, so the gate can link two bets to a fresh pillar and see the
 * roll-up. In-process only (mirrors the registry's offline cache).
 */
const linked = new Map<string, BetShare[]>();

/**
 * Register a stub bet share against a pillar (used when a Builder/Admin links a
 * Big Bet to a pillar before the real Big Bets registry exists). Idempotent by
 * (pillarId, bet.id); re-normalises shares so they always sum to 1.
 */
export function linkBetStub(pillarId: string, bet: BetShare): void {
  const list = linked.get(pillarId) ?? [];
  const next = [...list.filter((b) => b.id !== bet.id), bet];
  normaliseShares(next);
  linked.set(pillarId, next);
}

export function unlinkBetStub(pillarId: string, betId: string): void {
  const list = linked.get(pillarId);
  if (!list) return;
  const next = list.filter((b) => b.id !== betId);
  normaliseShares(next);
  linked.set(pillarId, next);
}

/** Re-normalise sharePct so Σ === 1 (keeps the reconcile invariant true). */
function normaliseShares(bets: BetShare[]): void {
  const sum = bets.reduce((a, b) => a + b.sharePct, 0);
  if (sum <= 0) return;
  for (const b of bets) b.sharePct = b.sharePct / sum;
}

export const defaultBetShareSource: BetShareSource = {
  async forPillar(pillarId: string): Promise<BetShare[]> {
    const dyn = linked.get(pillarId);
    if (dyn && dyn.length) return dyn;
    return STUB[pillarId] ?? [];
  },
};

/** Catalogue of bets the UI can offer to link (stub stand-in for Big Bets). */
export const STUB_BET_CATALOGUE: BetShare[] = [
  ...STUB.seed_pillar_retention,
  {
    id: 'seed_bet_self_serve',
    name: 'Self-serve analytics agent',
    domain: 'sales',
    sharePct: 1,
    components: [
      { id: 'seed_agent_rag', name: 'Domain RAG agent', kind: 'agent', weight: 0.5 },
      { id: 'seed_metric_ttinsight', name: 'Time-to-insight metric', kind: 'metric', weight: 0.2 },
      { id: 'seed_dash_selfserve', name: 'Self-serve dashboard', kind: 'dashboard', weight: 0.3 },
    ],
  },
];
