/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Strategy tab — pure data model + helpers (NO server imports, NO secrets) so
 * both client components and server adapters can import it.
 *
 * A **pillar** is a well-described strategic priority (Retention, Operational
 * efficiency, …). Decisions from `strategy-golden-path.md` (2026-06-30):
 *
 *   • Scope: shared **tenant** pillars (one company scorecard every domain
 *     contributes to) PLUS optional **domain** pillars for local priorities.
 *   • Each pillar carries one+ **business value metric** (a governed Cube
 *     metric — referenced, never copied) that is the pillar's TOTAL value.
 *   • Value flows **top-down**: pillar metric → distributed to its Big Bets →
 *     distributed to each bet's components, reconciling back up.
 *   • **Targets** (annual north-star + quarterly sub-targets) for value
 *     generated, active Creators & Builders, and promoted/certified counts of
 *     six artifact kinds — tracked against **monthly** actuals + trend.
 *
 * The roll-up + RLS scoping live in `value-rollup.ts`; adoption derivation in
 * `adoption.ts`; persistence + governance in `pillars.ts`.
 */

import type { Role } from '@/lib/session';

// ---------------------------------------------------------------- Scope --------

export type PillarScope = 'tenant' | 'domain';

/** The six promoted/certified artifact kinds the scoreboard tracks. */
export type ArtifactKind = 'data' | 'metric' | 'dashboard' | 'agent' | 'software' | 'ml';

export const ARTIFACT_KINDS: ArtifactKind[] = [
  'data',
  'metric',
  'dashboard',
  'agent',
  'software',
  'ml',
];

export const KIND_LABEL: Record<ArtifactKind, string> = {
  data: 'Data products',
  metric: 'Metrics',
  dashboard: 'Dashboards',
  agent: 'Agents',
  software: 'Software',
  ml: 'ML models',
};

/**
 * How realized value is read off the business metric (decided, per pillar):
 *   • uplift   — gain over a captured baseline (default)
 *   • absolute — the metric's absolute value
 *   • declared — owner-declared, corroborated by the metric
 */
export type ValueBasis = 'uplift' | 'absolute' | 'declared';

/** Link to a governed Cube metric — the pillar's business value metric. */
export type MetricLink = {
  /** Cube name (e.g. `daily_revenue`). */
  cube: string;
  /** Fully-qualified measure (e.g. `daily_revenue.total_revenue`). */
  measure: string;
  /** Human title shown in the UI. */
  title: string;
  /** Realized-value basis. */
  basis: ValueBasis;
  /** Captured baseline (used when basis = 'uplift'); same unit as the measure. */
  baseline?: number;
  /** Offline-seed total used when Cube is unreachable (deterministic demo). */
  seedTotal: number;
};

// -------------------------------------------------------------- Targets --------

export type Quarter = 'q1' | 'q2' | 'q3' | 'q4';
export const QUARTERS: Quarter[] = ['q1', 'q2', 'q3', 'q4'];

/** An annual north-star with its four quarterly sub-targets. */
export type AnnualQuarterly = {
  annual: number;
  quarterly: Record<Quarter, number>;
};

/** The full target set for a pillar (value · people · adoption by kind). */
export type TargetSet = {
  /** Business value generated (€), Σ of the pillar's bets. */
  valueGenerated: AnnualQuarterly;
  /** Number of active Creators in scope. */
  activeCreators: AnnualQuarterly;
  /** Number of active Builders in scope. */
  activeBuilders: AnnualQuarterly;
  /** Promoted/certified counts, per artifact kind. */
  certified: Record<ArtifactKind, AnnualQuarterly>;
};

export function emptyAnnualQuarterly(annual = 0): AnnualQuarterly {
  const per = annual ? Math.round((annual / 4) * 100) / 100 : 0;
  return { annual, quarterly: { q1: per, q2: per, q3: per, q4: per } };
}

export function emptyTargetSet(): TargetSet {
  const certified = {} as Record<ArtifactKind, AnnualQuarterly>;
  for (const k of ARTIFACT_KINDS) certified[k] = emptyAnnualQuarterly(0);
  return {
    valueGenerated: emptyAnnualQuarterly(0),
    activeCreators: emptyAnnualQuarterly(0),
    activeBuilders: emptyAnnualQuarterly(0),
    certified,
  };
}

// --------------------------------------------------------------- Pillar --------

export type Pillar = {
  id: string;
  name: string;
  description: string;
  scope: PillarScope;
  /**
   * For scope='domain' the owning domain; for scope='tenant' the literal
   * 'tenant' (a shared pillar every domain contributes to).
   */
  domain: string;
  /** User id of the creating Builder/Admin. */
  owner: string;
  /** The pillar's business value metric(s) — governed Cube metrics. */
  metrics: MetricLink[];
  /** Contributing Big Bet ids (references; bets live in the Big Bets tab). */
  betIds: string[];
  /** Annual + quarterly targets; absent until a Builder/Admin sets them. */
  targets?: TargetSet;
  createdAt: string;
  updatedAt: string;
};

// ----------------------------------------------------- Entitlement (RLS) -------

/**
 * Whether a viewer is entitled to see values scoped to `domain`. This is the
 * application-layer RLS gate the value roll-up applies on top of the governed
 * (already RLS-scoped) Cube metric, so two viewers see only their entitled
 * numbers. The 'tenant' scope is visible to everyone in the tenant; a domain's
 * numbers are visible to members of that domain (and to a platform Admin, who
 * is tenant-wide).
 */
export function entitledToDomain(
  user: { domains: string[]; role: Role },
  domain: string,
): boolean {
  if (domain === 'tenant') return true;
  if (user.domains.includes(domain)) return true;
  // A platform Admin is tenant-wide.
  return user.role === 'admin' && user.domains.includes('platform');
}

/** Whether a user may view a pillar at all (tenant pillars: everyone). */
export function canViewPillar(
  user: { domains: string[]; role: Role },
  pillar: Pick<Pillar, 'scope' | 'domain'>,
): boolean {
  if (pillar.scope === 'tenant') return true;
  return entitledToDomain(user, pillar.domain);
}

/**
 * Whether a user may define/edit a pillar or its targets. Builder edits their
 * own domain pillars; Admin edits tenant pillars + any domain they belong to.
 * Creators/Users (participant) never edit. (`strategy-golden-path.md` §Roles.)
 */
export function canEditPillar(
  user: { domains: string[]; role: Role },
  pillar: Pick<Pillar, 'scope' | 'domain'>,
): boolean {
  if (user.role === 'participant') return false;
  if (pillar.scope === 'tenant') {
    // Tenant-wide pillars are Admin-owned.
    return user.role === 'admin';
  }
  // Domain pillar: a Builder/Admin who belongs to that domain.
  return (user.role === 'builder' || user.role === 'admin') && user.domains.includes(pillar.domain);
}

/** Whether a user may create a pillar of the given scope. */
export function canCreatePillar(
  user: { domains: string[]; role: Role },
  scope: PillarScope,
  domain: string,
): boolean {
  return canEditPillar(user, { scope, domain });
}

// ------------------------------------------------------- Trend / pacing --------

export type Trend = 'on-track' | 'behind' | 'no-target';

/**
 * Pace a single actual against an annual target given the fraction of the year
 * elapsed. On-track when the actual meets the linear pace to date (with a small
 * tolerance); 'no-target' when the annual target is zero/unset.
 */
export function trendFor(actual: number, annualTarget: number, yearFraction: number): Trend {
  if (!annualTarget || annualTarget <= 0) return 'no-target';
  const expected = annualTarget * clamp01(yearFraction);
  // 5% tolerance band so a tiny shortfall doesn't read as "behind".
  return actual >= expected * 0.95 ? 'on-track' : 'behind';
}

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Fraction of the calendar year elapsed at `date` (UTC). */
export function yearFraction(date = new Date()): number {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return clamp01((date.getTime() - start) / (end - start));
}

/** The current quarter key for `date`. */
export function currentQuarter(date = new Date()): Quarter {
  return QUARTERS[Math.floor(date.getUTCMonth() / 3)];
}

/** Year-month key (e.g. `2026-06`) used to key monthly snapshots. */
export function monthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// --------------------------------------------------------- Reconciliation ------

/** Sums reconcile when |a − b| ≤ max(1, 0.5% of |b|) — integer-cent tolerance. */
export function reconciles(sum: number, total: number): boolean {
  return Math.abs(sum - total) <= Math.max(1, Math.abs(total) * 0.005);
}

// ------------------------------------------------ Top-down distribution -------
//
// PURE value-distribution core (no server imports) — the heart of the roll-up,
// extracted here so it is unit-testable and the server adapter (value-rollup.ts)
// stays a thin "resolve the governed total, then distribute" wrapper.

/** A bet's share of a pillar, plus its component weights (structural input). */
export type DistributableBet = {
  id: string;
  name: string;
  domain: string;
  sharePct: number; // fraction of the pillar total (0..1)
  components: { id: string; name: string; kind: ArtifactKind; weight: number }[];
};

export type DistributedComponent = {
  id: string;
  name: string;
  kind: ArtifactKind;
  value: number | null; // masked to null when viewer not entitled to the bet's domain
  entitled: boolean;
};

export type DistributedBet = {
  id: string;
  name: string;
  domain: string;
  /** Masked to null when the viewer is not entitled (else total×share leaks value). */
  sharePct: number | null;
  value: number | null;
  entitled: boolean;
  components: DistributedComponent[];
};

export type Distribution = {
  bets: DistributedBet[];
  /** Σ of ALL bet values (un-masked) — for the reconcile check. */
  decomposedTotal: number;
  reconciled: boolean;
  /** Σ of the values the viewer is entitled to see. */
  visibleTotal: number;
  /** total − visibleTotal: value withheld from this viewer (RLS). */
  maskedTotal: number;
};

/** Round to whole € so reconciliation is exact-to-the-euro. */
export function eur(n: number): number {
  return Math.round(n);
}

/**
 * Distribute a pillar's € `total` top-down across its bets (by share) and each
 * bet across its components (by weight), masking values the viewer is not
 * entitled to. The full (un-masked) decomposition is summed for the reconcile
 * check, so reconciliation holds regardless of who is looking — only visibility
 * differs. This is the RLS-correct spine the gate exercises.
 */
export function distributeValue(
  total: number,
  bets: DistributableBet[],
  viewer: { domains: string[]; role: Role },
): Distribution {
  let decomposedTotal = 0;
  let visibleTotal = 0;

  const out: DistributedBet[] = bets.map((bet) => {
    const betValueFull = eur(total * bet.sharePct);
    decomposedTotal += betValueFull;
    const entitled = entitledToDomain(viewer, bet.domain);
    if (entitled) visibleTotal += betValueFull;
    // Allocate the rounding remainder to the LAST component so component values
    // sum EXACTLY to the bet value (Σ components = bet), not just approximately.
    let allocated = 0;
    const components: DistributedComponent[] = bet.components.map((c, i, arr) => {
      let value: number | null = null;
      if (entitled) {
        value = i === arr.length - 1 ? betValueFull - allocated : eur(betValueFull * c.weight);
        allocated += value;
      }
      return { id: c.id, name: c.name, kind: c.kind, value, entitled };
    });
    return {
      id: bet.id,
      name: bet.name,
      domain: bet.domain,
      // Mask the share too: total is visible to pillar viewers, so exposing
      // sharePct would let a non-entitled viewer recover value = total × share.
      sharePct: entitled ? bet.sharePct : null,
      value: entitled ? betValueFull : null,
      entitled,
      components,
    };
  });

  return {
    bets: out,
    decomposedTotal,
    reconciled: reconciles(decomposedTotal, total),
    visibleTotal,
    maskedTotal: Math.max(0, total - visibleTotal),
  };
}

/** Format a € value compactly (e.g. €1.2M, €540k, €820). */
export function euro(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  // Threshold at 999.5k (not 1M) so 999,800 reads "€1.0M", never "€1000k".
  if (abs >= 999_500) return `€${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `€${Math.round(value / 1000)}k`;
  return `€${Math.round(value)}`;
}
