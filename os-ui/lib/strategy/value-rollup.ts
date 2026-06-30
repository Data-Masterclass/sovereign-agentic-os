/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { cubeScalar } from '@/lib/governed';
import {
  type Pillar,
  type MetricLink,
  type DistributedBet,
  type ValueMode,
  type ValueEntry,
  distributeValue,
  latestManualValue,
  eur,
} from '@/lib/strategy/model';
import { defaultBetShareSource, type BetShareSource } from '@/lib/strategy/bets-bridge';

/**
 * Value roll-up — the RLS-correct, top-down value spine (Opus-owned).
 *
 * The pillar's business value metric is the TOTAL (a governed Cube metric,
 * already RLS-scoped at the semantic layer). We resolve that total, apply the
 * pillar's value basis (uplift over baseline / absolute / declared), then
 * DISTRIBUTE it down to the contributing Big Bets by their declared shares, and
 * each bet down to its components by weight — so every component carries a € value
 * and the decomposition RECONCILES back up (Σ components = bet; Σ bets = total).
 *
 * RLS is enforced a SECOND time at the application layer on top of Cube: a viewer
 * only sees the € value of bets/components in domains they are entitled to. The
 * server still computes the full decomposition (to prove reconciliation), but the
 * response masks non-entitled values to `null` — so two viewers of the same pillar
 * see different, correctly-scoped numbers, and the reconcile check uses the full
 * (un-masked) figures. There is NO privileged side-channel: the total itself is
 * the governed metric, resolved the same way agents and dashboards resolve it.
 */

export type BetValue = DistributedBet;

export type PillarRollup = {
  pillarId: string;
  metricTitle: string;
  /** One-line description of the value metric (from the pillar's `valueMetric`). */
  metricDescription: string;
  /** How the value is kept: described-only, governed (Metrics tab), or manual. */
  mode: ValueMode;
  /** The pillar's realized value total (governed metric, basis-adjusted). */
  total: number;
  /** Where the total came from. */
  source: 'cube' | 'seed-offline' | 'manual';
  basis: MetricLink['basis'];
  bets: BetValue[];
  /** Σ of ALL bet values (server-side, un-masked) — used for the reconcile check. */
  decomposedTotal: number;
  /** Whether Σ bets reconciles to the pillar total (within tolerance). */
  reconciled: boolean;
  /** Σ of the values THIS viewer is entitled to see. */
  visibleTotal: number;
  /** total − visibleTotal: value present but withheld from this viewer (RLS). */
  maskedTotal: number;
};

const EMPTY_USER_DOMAINS = { domains: [] as string[], role: 'participant' as const };

/** Resolve a metric's raw total from Cube, falling back to the deterministic seed. */
async function resolveTotal(
  metric: MetricLink,
): Promise<{ raw: number; source: 'cube' | 'seed-offline' }> {
  try {
    const v = await cubeScalar(
      { measures: [metric.measure], limit: 1 },
      metric.measure,
    );
    // Accept a genuine 0 (no realized value yet) as a real Cube answer; only a
    // null (no rows / unreachable) falls through to the deterministic seed.
    if (v !== null && Number.isFinite(v) && v >= 0) return { raw: v, source: 'cube' };
  } catch {
    /* Cube unreachable locally — fall through to the seed. */
  }
  return { raw: metric.seedTotal, source: 'seed-offline' };
}

/** Apply the pillar's value basis to the raw metric value → realized value. */
function applyBasis(raw: number, metric: MetricLink): number {
  if (metric.basis === 'uplift') return Math.max(0, raw - (metric.baseline ?? 0));
  // 'absolute' and 'declared' both report the metric's value as-is here
  // (declared is corroborated by the metric, not a separate number).
  return raw;
}

/**
 * Compute the RLS-scoped value roll-up for a pillar as seen by `user`. Uses the
 * pillar's FIRST metric as the headline total (multi-metric pillars surface the
 * others in the UI; the roll-up distributes the headline). Resolves the governed
 * total from Cube, then hands off to the pure `distributeValue` spine.
 */
export async function rollupForPillar(
  pillar: Pillar,
  user: { domains: string[]; role: 'participant' | 'creator' | 'builder' | 'admin' } = EMPTY_USER_DOMAINS,
  source: BetShareSource = defaultBetShareSource,
): Promise<PillarRollup> {
  const vm = pillar.valueMetric;
  const metric = pillar.metrics[0];
  // Resolve the headline total + where it came from, per value mode.
  let total = 0;
  let totalSource: PillarRollup['source'] = 'manual';
  let metricTitle = vm?.name || metric?.title || '—';
  const mode: ValueMode = vm?.mode ?? (metric ? 'governed' : 'describe');
  const basis: MetricLink['basis'] = metric?.basis ?? 'absolute';

  if (mode === 'manual') {
    total = eur(latestManualValue(vm));
    totalSource = 'manual';
    metricTitle = vm?.name || 'Manual value';
  } else if (mode === 'governed' && metric) {
    const r = await resolveTotal(metric);
    total = eur(applyBasis(r.raw, metric));
    totalSource = r.source;
    metricTitle = vm?.name || metric.title;
  } else {
    // 'describe' (or governed-but-no-link): described only — no number flows yet.
    total = 0;
    totalSource = 'manual';
  }

  // Distribute even a zero total so the bet/component structure still renders.
  const shares = await source.forPillar(pillar.id);
  const dist = distributeValue(total, shares, user);

  return {
    pillarId: pillar.id,
    metricTitle,
    metricDescription: vm?.description ?? '',
    mode,
    total,
    source: totalSource,
    basis,
    bets: dist.bets,
    decomposedTotal: dist.decomposedTotal,
    reconciled: dist.reconciled,
    visibleTotal: dist.visibleTotal,
    maskedTotal: dist.maskedTotal,
  };
}

/**
 * The value metric's history — its value over time, for the evolving chart.
 * Manual pillars use their monthly entries directly; governed/legacy pillars use
 * the monthly actuals snapshots' realized value. Oldest → newest.
 */
export function valueHistory(
  pillar: Pillar,
  snapshots: { month: string; valueGenerated: number }[] = [],
): { month: string; value: number }[] {
  const vm = pillar.valueMetric;
  if (vm?.mode === 'manual') {
    return vm.entries
      .slice()
      .sort((a: ValueEntry, b: ValueEntry) => a.month.localeCompare(b.month))
      .map((e) => ({ month: e.month, value: e.value }));
  }
  return snapshots
    .slice()
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((s) => ({ month: s.month, value: s.valueGenerated }));
}
