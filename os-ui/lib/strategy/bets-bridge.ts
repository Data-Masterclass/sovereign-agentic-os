/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { ArtifactKind, ComponentBuildStatus } from '@/lib/strategy/model';
import { entitledToDomain } from '@/lib/strategy/model';
import type { Role } from '@/lib/core/session';
import type { BigBet, Tab } from '@/lib/bigbets';
import { _allBets, canView } from '@/lib/bigbets/store';
import { resolveArtifact } from '@/lib/bigbets';

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
  /** Bet go-live date (ISO yyyy-mm-dd) — the roadmap axis end marker. */
  goLive?: string;
  /** Component breakdown; weights are fractions of the bet (sum to 1). */
  components: BetComponentShare[];
};

export type BetComponentShare = {
  id: string;
  name: string;
  kind: ArtifactKind;
  /** Fraction of the bet's value this component carries (0..1). */
  weight: number;
  /** Build state — drives the Planned/In progress/Ready counts in the detail view. */
  status?: ComponentBuildStatus;
  /** Planned-ready / due date (ISO yyyy-mm-dd) for the roadmap timeline. */
  dueDate?: string;
  /** The real artifact id this references — for the component's Edit→tab deep-link. */
  artifactId?: string;
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
      goLive: '2026-09-30',
      components: [
        { id: 'seed_dp_churn', name: 'Churn data product', kind: 'data', weight: 0.25, status: 'ready', dueDate: '2026-05-15', artifactId: 'data_churn_mart' },
        { id: 'seed_ml_churn', name: 'Churn model', kind: 'ml', weight: 0.35, status: 'in-progress', dueDate: '2026-07-31', artifactId: 'ml_churn_v2' },
        { id: 'seed_dash_churn', name: 'Churn Risk dashboard', kind: 'dashboard', weight: 0.2, status: 'in-progress', dueDate: '2026-08-15', artifactId: 'dash_churn_risk' },
        { id: 'seed_agent_retention', name: 'Sales retention agent', kind: 'agent', weight: 0.2, status: 'planned', dueDate: '2026-09-20', artifactId: 'agent_retention' },
      ],
    },
    {
      id: 'seed_bet_winback',
      name: 'Win-back campaign',
      domain: 'marketing',
      sharePct: 0.4,
      goLive: '2026-10-31',
      components: [
        { id: 'seed_dp_winback', name: 'Lapsed-customer data product', kind: 'data', weight: 0.4, status: 'ready', dueDate: '2026-06-01', artifactId: 'data_lapsed' },
        { id: 'seed_dash_winback', name: 'Win-back dashboard', kind: 'dashboard', weight: 0.3, status: 'planned', dueDate: '2026-09-10', artifactId: 'dash_winback' },
        { id: 'seed_agent_winback', name: 'Win-back outreach agent', kind: 'agent', weight: 0.3, status: 'planned', dueDate: '2026-10-05', artifactId: 'agent_winback' },
      ],
    },
  ],
};

/**
 * Bet shares keyed dynamically: pillars created at runtime link bets by id via
 * `linkBetStub`, so the gate can link two bets to a fresh pillar and see the
 * roll-up. Pinned to globalThis so every route-handler module instance shares
 * the same Map (same pattern as lib/marketplace/store.ts).
 */
type BetsBridgeState = { linked: Map<string, BetShare[]> };
const BRIDGE_KEY = Symbol.for('soa.strategy.bets-bridge');
function bridgeState(): BetsBridgeState {
  const g = globalThis as unknown as Record<symbol, BetsBridgeState | undefined>;
  if (!g[BRIDGE_KEY]) g[BRIDGE_KEY] = { linked: new Map() };
  return g[BRIDGE_KEY]!;
}

/**
 * Register a stub bet share against a pillar (used when a Builder/Admin links a
 * Big Bet to a pillar before the real Big Bets registry exists). Idempotent by
 * (pillarId, bet.id); re-normalises shares so they always sum to 1.
 */
export function linkBetStub(pillarId: string, bet: BetShare): void {
  const { linked } = bridgeState();
  const list = linked.get(pillarId) ?? [];
  const next = [...list.filter((b) => b.id !== bet.id), bet];
  normaliseShares(next);
  linked.set(pillarId, next);
}

export function unlinkBetStub(pillarId: string, betId: string): void {
  const { linked } = bridgeState();
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

// ---------------------------------------------- REAL Big Bets adapter --------
//
// The bridge now reads REAL bets from the Big Bets registry (lib/bigbets/store)
// so student-created bets appear in Strategy — both in the "link a bet" catalogue
// and in a pillar's value roll-up — scoped by the bets store's OWN `canView`
// (domain + membership; cross-domain bets are members/admin only). The STUB seed
// stays as a fallback so the worked-example demo + existing tests keep working.

/** A scope carrier compatible with both the bigbets `canView` and `entitledToDomain`. */
type BetViewer = { id: string; domains: string[]; role: Role };

const KIND_OF_TAB: Record<Tab, ArtifactKind> = {
  data: 'data',
  metric: 'metric',
  dashboard: 'dashboard',
  software: 'software',
  agent: 'agent',
  ml: 'ml',
  knowledge: 'data',
  files: 'data',
  connection: 'data',
};

/** Map a REAL BigBet to the pillar-facing BetShare (component weights → fractions). */
function realBetToShare(bet: BigBet): BetShare {
  const comps = bet.components;
  const totalW = comps.reduce((s, c) => s + (c.weight || 0), 0);
  const components: BetComponentShare[] = comps.map((c) => ({
    id: c.id,
    name: resolveArtifact(c.artifactId)?.title ?? `${c.tab} component`,
    kind: KIND_OF_TAB[c.tab],
    weight: totalW > 0 ? (c.weight || 0) / totalW : comps.length ? 1 / comps.length : 0,
    dueDate: c.plannedReady,
    artifactId: c.artifactId,
  }));
  return {
    id: bet.id,
    name: bet.name,
    domain: bet.domain,
    // The bet's pillar-relative share is re-normalised across the pillar's bets on
    // link/roll-up; a real bet contributes an equal default share to start.
    sharePct: 1,
    goLive: bet.goLive,
    components,
  };
}

/**
 * The bets a viewer can offer to link to a pillar: REAL bets they may see (via the
 * Big Bets store's canView) ∪ the STUB seed (entitled domains only), deduped by id.
 * Never leaks a cross-domain / other-user bet — each gate is the tab's own.
 */
export function betCatalogue(user: BetViewer): BetShare[] {
  const real = _allBets()
    .filter((b) => canView(b, user))
    .map(realBetToShare);
  const seen = new Set(real.map((b) => b.id));
  const stub = STUB_BET_CATALOGUE.filter((b) => entitledToDomain(user, b.domain) && !seen.has(b.id));
  return [...real, ...stub];
}

export const defaultBetShareSource: BetShareSource = {
  async forPillar(pillarId: string): Promise<BetShare[]> {
    // REAL bets tagged to this pillar (bet.pillarId) + any dynamically-linked stub
    // shares, deduped by id. Value roll-up masks each bet's € by domain (RLS), so
    // returning the full set here is correct — visibility is enforced downstream.
    const real = _allBets()
      .filter((b) => b.pillarId === pillarId)
      .map(realBetToShare);
    const seen = new Set(real.map((b) => b.id));
    const dyn = (bridgeState().linked.get(pillarId) ?? []).filter((b) => !seen.has(b.id));
    const merged = [...real, ...dyn];
    if (merged.length) {
      normaliseShares(merged);
      return merged;
    }
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
