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

import { roleAtLeast, type Role } from '@/lib/core/session';

// ---------------------------------------------------------------- Scope --------

/**
 * A pillar's TIER, lowest→highest reach (presented in the UI as My · Domain ·
 * Company):
 *   • 'personal' — **My**: private to its owner; only the owner sees/edits it.
 *   • 'domain'   — visible to that domain's members; editable by the owner or a
 *                  Builder+ in the domain (the shared-edit rule).
 *   • 'tenant'   — **Company**: visible to everyone in the tenant; Admin-owned.
 *
 * Back-compat: `'personal'` is NEW. Pre-existing pillars only ever carried
 * 'domain' | 'tenant', so no stored data changes — the new tier is purely additive
 * and existing pillars keep their current scope.
 */
export type PillarScope = 'personal' | 'domain' | 'tenant';

/** The three tiers, lowest→highest, for iteration + the promote ladder. */
export const PILLAR_SCOPES: PillarScope[] = ['personal', 'domain', 'tenant'];

/** User-facing tier label — My · Domain · Company. */
export const PILLAR_SCOPE_LABEL: Record<PillarScope, string> = {
  personal: 'My',
  domain: 'Domain',
  tenant: 'Company',
};

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
 * Where a component of each kind lives — the tab route a component's "Edit"
 * button deep-links to (jump straight to the artifact in its own tab). ML models
 * live under Science. `?focus=<id>` is appended so a tab can scroll to it.
 */
export const KIND_ROUTE: Record<ArtifactKind, string> = {
  data: '/data',
  metric: '/metrics',
  dashboard: '/dashboards',
  agent: '/agents',
  software: '/software',
  ml: '/science',
};

/** The three states a big-bet component rolls up to (mirrors Big Bets). */
export type ComponentBuildStatus = 'planned' | 'in-progress' | 'ready';

export const BUILD_STATUS_LABEL: Record<ComponentBuildStatus, string> = {
  planned: 'Planned',
  'in-progress': 'In progress',
  ready: 'Ready',
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

// -------------------------------------------------- Value metric (describe) ----
//
// A pillar's value metric is FIRST just described (a name + a sentence). The
// company then chooses how its number is kept:
//   • 'describe' — described only; no number flows yet (honest empty state).
//   • 'governed' — set up as a real governed Cube metric in the Metrics tab; the
//                  value flows back automatically (the `metrics[0]` link).
//   • 'manual'   — the company enters the new value each month, right here in
//                  Strategy. Those entries feed the total value + the history.

export type ValueMode = 'describe' | 'governed' | 'manual';

/** One manual monthly value entry (newest wins for the headline total). */
export type ValueEntry = {
  /** Year-month key, e.g. `2026-06`. */
  month: string;
  /** The value as of that month (same unit as the metric). */
  value: number;
  at: string;
  by: string;
};

// ------------------------------------------------ Value-metric TYPE ------------
//
// A pillar's headline value is tied to a value-metric TYPE. Four SUGGESTED types
// plus a Custom one where the user types the metric name + an optional unit label
// and marks whether it is monetary. The type decides how the big target number is
// FORMATTED (monetary → tenant currency; hours → "h"; count → integer; custom →
// its own unit label). The governed METRIC_CATALOGUE link stays available; this is
// the pillar's headline value-metric type.

export type MetricType = 'ebit' | 'revenue' | 'time-back-hours' | 'risks-mitigated' | 'custom';

export const METRIC_TYPES: MetricType[] = ['ebit', 'revenue', 'time-back-hours', 'risks-mitigated', 'custom'];

/** Static shape of a suggested metric type (Custom is described on the pillar). */
export type MetricTypeSpec = {
  label: string;
  /** Non-currency unit suffix (e.g. 'h'); '' for monetary or count. */
  unit: string;
  /** Whether the number is money (→ tenant currency) rather than a plain unit. */
  monetary: boolean;
  /** Round to a whole integer when displaying (counts). */
  integer: boolean;
};

export const METRIC_TYPE_SPECS: Record<Exclude<MetricType, 'custom'>, MetricTypeSpec> = {
  ebit: { label: 'EBIT', unit: '', monetary: true, integer: false },
  revenue: { label: 'Revenue', unit: '', monetary: true, integer: false },
  'time-back-hours': { label: 'Time Back Hours', unit: 'h', monetary: false, integer: false },
  'risks-mitigated': { label: '# Risks Mitigated', unit: '', monetary: false, integer: true },
};

export const METRIC_TYPE_LABEL: Record<MetricType, string> = {
  ebit: 'EBIT',
  revenue: 'Revenue',
  'time-back-hours': 'Time Back Hours',
  'risks-mitigated': '# Risks Mitigated',
  custom: 'Custom',
};

/** A pillar's described value metric + how its number is kept. */
export type ValueMetric = {
  name: string;
  description: string;
  mode: ValueMode;
  /** Manual monthly entries (mode='manual'); oldest → newest. */
  entries: ValueEntry[];
  /** Headline value-metric TYPE (drives target formatting). Legacy pillars omit it. */
  metricType?: MetricType;
  /** For metricType='custom': the unit label the user typed (e.g. 'tickets'), or ''. */
  customUnit?: string;
  /** For metricType='custom': whether the custom metric is monetary (→ tenant currency). */
  customMonetary?: boolean;
};

export function emptyValueMetric(name = '', description = ''): ValueMetric {
  return { name, description, mode: 'describe', entries: [] };
}

/** Whether the value metric is monetary (→ formatted in the tenant currency). */
export function isMonetaryMetric(vm: ValueMetric | undefined): boolean {
  const t = vm?.metricType;
  if (!t) return true; // legacy default: monetary (€ roll-up)
  if (t === 'custom') return Boolean(vm?.customMonetary);
  return METRIC_TYPE_SPECS[t].monetary;
}

/** The non-currency unit suffix for a value metric ('' when monetary). */
export function metricUnitOf(vm: ValueMetric | undefined): string {
  const t = vm?.metricType;
  if (!t || t === 'custom') return t === 'custom' && !vm?.customMonetary ? (vm?.customUnit ?? '') : '';
  return METRIC_TYPE_SPECS[t].unit;
}

/** The latest manual value (the headline total when mode='manual'), or 0. */
export function latestManualValue(vm: ValueMetric | undefined): number {
  if (!vm || vm.entries.length === 0) return 0;
  return vm.entries[vm.entries.length - 1].value;
}

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

// ----------------------------------------------- Headline horizon target -------
//
// The pillar card's BIG NUMBER: a target `value`, measured by a `metricType`,
// against a HORIZON with a clear end date. Year-end defaults to Dec 31 of the
// current calendar year; the N-month horizons compute endDate = setAt + N months.

export type Horizon = 'year-end' | '6-month' | '12-month' | '24-month' | '36-month';

export const HORIZONS: Horizon[] = ['year-end', '6-month', '12-month', '24-month', '36-month'];

export const HORIZON_LABEL: Record<Horizon, string> = {
  'year-end': 'Year-end',
  '6-month': '6-month',
  '12-month': '12-month',
  '24-month': '24-month',
  '36-month': '36-month',
};

/** Months to add for each N-month horizon ('year-end' is special-cased). */
const HORIZON_MONTHS: Record<Exclude<Horizon, 'year-end'>, number> = {
  '6-month': 6,
  '12-month': 12,
  '24-month': 24,
  '36-month': 36,
};

/** The pillar's headline target: big number + metric type + horizon end date. */
export type HorizonTarget = {
  value: number;
  metricType: MetricType;
  horizon: Horizon;
  /** ISO yyyy-mm-dd the target runs to (year-end = Dec 31 this year; else setAt + N months). */
  endDate: string;
  /** ISO datetime the target was set (the clock the N-month horizons count from). */
  setAt: string;
};

/** ISO yyyy-mm-dd for a horizon, counted from `setAt` (default now). */
export function computeEndDate(horizon: Horizon, setAt: Date = new Date()): string {
  if (horizon === 'year-end') {
    return `${setAt.getUTCFullYear()}-12-31`;
  }
  const months = HORIZON_MONTHS[horizon];
  const d = new Date(Date.UTC(setAt.getUTCFullYear(), setAt.getUTCMonth() + months, setAt.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/** A fresh year-end target for the current year (the default when none is set). */
export function emptyHorizonTarget(setAt: Date = new Date()): HorizonTarget {
  return {
    value: 0,
    metricType: 'ebit',
    horizon: 'year-end',
    endDate: computeEndDate('year-end', setAt),
    setAt: setAt.toISOString(),
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
   * 'tenant' (a shared pillar every domain contributes to); for scope='personal'
   * the owner's home domain (retained so a later promote to Domain has a target).
   */
  domain: string;
  /** User id of the creating Builder/Admin. */
  owner: string;
  /** The pillar's business value metric(s) — governed Cube metrics. */
  metrics: MetricLink[];
  /**
   * The pillar's described value metric + manual monthly entries. When absent
   * (legacy), the pillar falls back to its first governed `metrics[0]` link.
   */
  valueMetric?: ValueMetric;
  /** Contributing Big Bet ids (references; bets live in the Big Bets tab). */
  betIds: string[];
  /** Annual + quarterly targets; absent until a Builder/Admin sets them. */
  targets?: TargetSet;
  /** The pillar's headline target (the card's big number); absent until set. */
  headlineTarget?: HorizonTarget;
  /** Soft-archive flag (reversible hide). Absent/false = live. Additive. */
  archived?: boolean;
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

/**
 * Whether a user may view a pillar at all.
 *   • personal (My) → the owner ONLY.
 *   • domain        → members of that domain (+ tenant-wide Admin).
 *   • tenant (Company) → everyone in the tenant.
 * `owner` is only consulted for the personal tier (legacy callers that pass just
 * `{ scope, domain }` keep working for the domain/tenant tiers).
 */
export function canViewPillar(
  user: { id?: string; domains: string[]; role: Role },
  pillar: Pick<Pillar, 'scope' | 'domain' | 'owner'>,
): boolean {
  if (pillar.scope === 'personal') return !!user.id && pillar.owner === user.id;
  if (pillar.scope === 'tenant') return true;
  return entitledToDomain(user, pillar.domain);
}

/**
 * Whether a user may define/edit a pillar or its targets.
 *   • personal (My) → the OWNER only (any role, including a Creator, edits their
 *                     own My pillar).
 *   • domain        → the owner, OR a Builder+ / domain_admin who belongs to that
 *                     domain (the OS shared-edit rule; a non-member never edits).
 *   • tenant (Company) → Admin-owned.
 * (`strategy-golden-path.md` §Roles + the 4-rank shared-edit rule.)
 */
export function canEditPillar(
  user: { id?: string; domains: string[]; role: Role },
  pillar: Pick<Pillar, 'scope' | 'domain' | 'owner'>,
): boolean {
  if (pillar.scope === 'personal') return !!user.id && pillar.owner === user.id;
  if (pillar.scope === 'tenant') {
    // Tenant-wide pillars are Admin-owned.
    return user.role === 'admin';
  }
  // Domain pillar: the owner, or a Builder+ who belongs to that domain.
  if (!!user.id && pillar.owner === user.id) return roleAtLeast(user.role, 'builder');
  return roleAtLeast(user.role, 'builder') && user.domains.includes(pillar.domain);
}

/**
 * Whether a user may create a pillar of the given scope. A **My** (personal)
 * pillar is open to any authenticated user in a domain they belong to; Domain
 * needs Builder+; Company needs Admin.
 */
export function canCreatePillar(
  user: { id?: string; domains: string[]; role: Role },
  scope: PillarScope,
  domain: string,
): boolean {
  // A NEW pillar has no owner yet, so the owner-edit shortcut must NOT apply —
  // creating in a shared tier requires the tier's role floor + domain membership.
  if (scope === 'personal') return domain === 'personal' || user.domains.includes(domain);
  if (scope === 'tenant') return user.role === 'admin';
  return roleAtLeast(user.role, 'builder') && user.domains.includes(domain);
}

/**
 * Whether a user may PROMOTE a pillar one tier UP (personal→domain→tenant),
 * mirroring the OS promote ladder (`promoteConnection`): promoting TO Domain needs
 * a Builder+ in the target domain; promoting TO Company (tenant) needs an Admin.
 * Only the owner (or an Admin) can initiate. Returns false at the top tier.
 */
export function nextPillarScope(scope: PillarScope): PillarScope | null {
  const i = PILLAR_SCOPES.indexOf(scope);
  return i >= 0 && i < PILLAR_SCOPES.length - 1 ? PILLAR_SCOPES[i + 1] : null;
}

export function canPromotePillar(
  user: { id?: string; domains: string[]; role: Role },
  pillar: Pick<Pillar, 'scope' | 'domain' | 'owner'>,
): boolean {
  const next = nextPillarScope(pillar.scope);
  if (!next) return false;
  // Owner or Admin may initiate the promotion.
  const isOwner = !!user.id && pillar.owner === user.id;
  if (!isOwner && user.role !== 'admin') return false;
  if (next === 'domain') {
    // Promote My → Domain: Builder+ in the owning domain (or Admin).
    return roleAtLeast(user.role, 'builder') && (user.role === 'admin' || user.domains.includes(pillar.domain));
  }
  // Promote Domain → Company: Admin only.
  return user.role === 'admin';
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

// ------------------------------------------------- Bet tier by containment ----
//
// A bet has NO tier of its own — its effective tier is its PARENT pillar's tier
// (via pillarId). A bet with no linked pillar (or an unknown one) is treated as
// personal ('My') so it never leaks into a shared surface by default. These pure
// helpers let both the server and the client segment bets by My/Domain/Company
// through the pillar map without duplicating the containment rule.

/** The tier a bet inherits from its parent pillar (personal when unlinked/unknown). */
export function betTier(
  pillarId: string | undefined,
  pillarScopeById: Map<string, PillarScope>,
): PillarScope {
  if (!pillarId) return 'personal';
  return pillarScopeById.get(pillarId) ?? 'personal';
}

/** Group a list of bets (anything carrying a `pillarId`) by inherited tier. */
export function groupBetsByTier<T extends { pillarId?: string }>(
  bets: T[],
  pillarScopeById: Map<string, PillarScope>,
): Record<PillarScope, T[]> {
  const out: Record<PillarScope, T[]> = { personal: [], domain: [], tenant: [] };
  for (const b of bets) out[betTier(b.pillarId, pillarScopeById)].push(b);
  return out;
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

/** A bet's component (structural input) — weight plus optional roadmap fields. */
export type DistributableComponent = {
  id: string;
  name: string;
  kind: ArtifactKind;
  weight: number;
  /** Build state (mirrors Big Bets) — drives the Planned/In progress/Ready counts. */
  status?: ComponentBuildStatus;
  /** Planned-ready / due date (ISO yyyy-mm-dd) — drives the roadmap timeline. */
  dueDate?: string;
  /** The real artifact id this component references — for the Edit→tab deep-link. */
  artifactId?: string;
};

/** A bet's share of a pillar, plus its component weights (structural input). */
export type DistributableBet = {
  id: string;
  name: string;
  domain: string;
  sharePct: number; // fraction of the pillar total (0..1)
  /** Bet go-live date (ISO yyyy-mm-dd) — the roadmap axis end marker. */
  goLive?: string;
  components: DistributableComponent[];
};

export type DistributedComponent = {
  id: string;
  name: string;
  kind: ArtifactKind;
  value: number | null; // masked to null when viewer not entitled to the bet's domain
  entitled: boolean;
  status: ComponentBuildStatus;
  dueDate: string | null;
  artifactId: string | null;
};

export type DistributedBet = {
  id: string;
  name: string;
  domain: string;
  /** Masked to null when the viewer is not entitled (else total×share leaks value). */
  sharePct: number | null;
  value: number | null;
  entitled: boolean;
  goLive: string | null;
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
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        value,
        entitled,
        status: c.status ?? 'planned',
        // Roadmap/edit fields are structural (not a € value) — shown to any
        // pillar viewer so the plan is legible; only the € value is RLS-masked.
        dueDate: c.dueDate ?? null,
        artifactId: c.artifactId ?? null,
      };
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
      goLive: bet.goLive ?? null,
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

// ----------------------------------------------------- Currency formatting -----
//
// The tenant currency is set in ADMIN (lib/platform-admin/settings.ts). The
// Strategy card READS it to format monetary metrics; non-monetary metrics ignore
// it. The Strategy tab never lets a user pick currency locally.

/** ISO-4217 currency code (EUR/CHF/USD are prominent; any code is accepted). */
export type Currency = string;

/** The symbol prefix for the common currencies; falls back to the code + space. */
export const CURRENCY_SYMBOL: Record<string, string> = {
  EUR: '€',
  CHF: 'CHF ',
  USD: '$',
  GBP: '£',
  JPY: '¥',
};

export function currencySymbol(currency: Currency): string {
  return CURRENCY_SYMBOL[currency] ?? `${currency} `;
}

/** Format a monetary value compactly in the given tenant currency (e.g. €2.5M, $540k). */
export function formatMoney(value: number | null | undefined, currency: Currency): string {
  if (value === null || value === undefined) return '—';
  const sym = currencySymbol(currency);
  const abs = Math.abs(value);
  if (abs >= 999_500) return `${sym}${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sym}${Math.round(value / 1000)}k`;
  return `${sym}${Math.round(value)}`;
}

/** Group a plain number with thousands separators (e.g. 1,200). */
function grouped(value: number, integer: boolean): string {
  const n = integer ? Math.round(value) : value;
  return n.toLocaleString('en-US', integer ? { maximumFractionDigits: 0 } : {});
}

/**
 * Format a headline value per the pillar's value-metric type + tenant currency.
 * Monetary (EBIT/Revenue/custom-monetary) → currency (e.g. €2.5M). Hours →
 * "1,200 h". Risks → integer count (e.g. "18 risks"). Custom (non-monetary) →
 * its own unit label. Currency is IGNORED for non-monetary metrics.
 */
export function formatMetricValue(
  value: number | null | undefined,
  vm: ValueMetric | undefined,
  currency: Currency,
): string {
  if (value === null || value === undefined) return '—';
  if (isMonetaryMetric(vm)) return formatMoney(value, currency);
  const t = vm?.metricType;
  const integer = t === 'risks-mitigated' || (t !== 'custom' && !!t && METRIC_TYPE_SPECS[t].integer);
  const unit = metricUnitOf(vm);
  // "# Risks Mitigated" reads best as a bare count with a "risks" noun.
  if (t === 'risks-mitigated') return `${grouped(value, true)} risks`;
  const num = grouped(value, integer);
  return unit ? `${num} ${unit}` : num;
}
