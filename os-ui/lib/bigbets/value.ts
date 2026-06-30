/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Value adapter (Opus spine) — top-down value distribution.
 *
 * Value flows pillar → bet → component. The pillar's governed business metric is
 * the TOTAL; it distributes to its bets; each bet distributes to its components;
 * and a fraction flows UP the composition map to the shared upstream assets the
 * leaves build on — so every component (and every shared data product/knowledge/
 * connection) carries a measured € value, and the shares RECONCILE back up.
 *
 * Three selectable knobs, all decided in the golden path:
 *   - realized-value BASIS (per bet): uplift-over-baseline (default) / absolute /
 *     owner-declared (corroborated by the metric);
 *   - allocation METHOD (per bet): manual weights (default) / usage-based / equal;
 *   - upstream credit: a fixed fraction of each leaf's share is transferred to the
 *     assets it consumes (conserves the total, so reconciliation still holds).
 *
 * Numbers are RLS-scoped: the metric is resolved through the viewer's entitlement
 * (resolveMetric), so two viewers see their own governed slice — never a side
 * channel.
 */

import {
  type AllocationMethod,
  type Artifact,
  type BigBet,
  type Tab,
  type ValueBasis,
  LEAF_TABS,
} from './model.ts';
import { resolveArtifact, resolveMetric } from './sources.ts';
import { type CompositionMap, downstreamCounts } from './composition.ts';

/** Fraction of a leaf component's value credited UP to the assets it builds on. */
const UPSTREAM_CREDIT = 0.25;
const EPS = 0.5; // €0.50 reconciliation tolerance (rounding)

export type RealizedValue = {
  basis: ValueBasis;
  target: number;
  realized: number;
  baseline: number;
  current: number;
  unit: '€' | '%' | 'count';
  /** For owner-declared: how far the declared figure sits from the metric. */
  corroboration?: { declared: number; metric: number; deltaPct: number };
};

/** Resolve a bet's realized value for a viewer, by the selected basis (RLS-scoped). */
export function realizedValue(bet: BigBet, viewerId: string): RealizedValue {
  const m = resolveMetric(bet.metricId, viewerId);
  const baseline = m?.baseline ?? 0;
  const current = m?.current ?? 0;
  const unit = m?.unit ?? '€';
  let realized: number;
  let corroboration: RealizedValue['corroboration'];
  switch (bet.valueBasis) {
    case 'absolute':
      realized = current;
      break;
    case 'owner-declared': {
      const declared = bet.ownerDeclaredValue ?? 0;
      realized = declared;
      const metricUplift = Math.max(0, current - baseline);
      const deltaPct = metricUplift === 0 ? 0 : Math.round(((declared - metricUplift) / metricUplift) * 100);
      corroboration = { declared, metric: metricUplift, deltaPct };
      break;
    }
    case 'uplift':
    default:
      realized = Math.max(0, current - baseline);
      break;
  }
  return { basis: bet.valueBasis, target: bet.targetValue, realized, baseline, current, unit, corroboration };
}

export type ComponentValue = {
  refId: string | null; // null for a shared upstream asset that isn't a tagged ref
  artifactId: string;
  tab: Tab;
  title: string;
  /** Total € value attributed to this component (base allocation ± credit transfer). */
  value: number;
  sharePct: number;
  /** Of `value`, how much was earned as upstream credit (0 for pure leaves). */
  upstreamCredit: number;
  upstream: boolean;
};

export type Distribution = {
  betValue: number;
  components: ComponentValue[];
  /** Σ component values === betValue (within tolerance). */
  reconciles: boolean;
  residual: number;
  allocation: AllocationMethod;
};

type Ref = { refId: string; artifactId: string };

/**
 * Distribute a bet's realized value across its components by the chosen method,
 * then transfer upstream credit along the composition map. Conserves the total.
 *
 * `refs` are the bet's tagged component references; `composition` supplies the
 * builds-on edges (and pulls in shared upstream assets to credit).
 */
export function distribute(
  betValue: number,
  refs: Ref[],
  weightByRef: Map<string, number>,
  method: AllocationMethod,
  composition: CompositionMap,
): Distribution {
  // Resolve the tagged components to artifacts.
  const tagged: { ref: Ref; art: Artifact }[] = [];
  for (const r of refs) {
    const art = resolveArtifact(r.artifactId);
    if (art) tagged.push({ ref: r, art });
  }

  const consumers = downstreamCounts(composition); // artifactId → #downstream

  // ---- base allocation across tagged components -------------------------------
  const baseWeight = new Map<string, number>(); // artifactId → relative weight
  for (const { ref, art } of tagged) {
    let w: number;
    if (method === 'manual') {
      w = weightByRef.get(ref.refId) ?? 0;
    } else if (method === 'usage') {
      // usage + position in the composition map (downstream pull).
      w = (art.usage30d + 1) * (1 + (consumers.get(art.id) ?? 0));
    } else {
      // equal — among value-generating leaves; upstream assets earn via credit only.
      w = LEAF_TABS.includes(art.tab) ? 1 : 0;
    }
    baseWeight.set(art.id, w);
  }
  let totalW = [...baseWeight.values()].reduce((a, b) => a + b, 0);
  if (totalW <= 0) {
    // Degenerate (all weights zero) → equal across every tagged component.
    for (const { art } of tagged) baseWeight.set(art.id, 1);
    totalW = tagged.length;
  }

  const valueByArtifact = new Map<string, number>();
  for (const { art } of tagged) {
    valueByArtifact.set(art.id, (betValue * (baseWeight.get(art.id) ?? 0)) / totalW);
  }

  // ---- upstream credit transfer along the composition edges -------------------
  // Each consumer gives UPSTREAM_CREDIT of its BASE allocation, split equally
  // across the assets it directly consumes (transitive credit emerges as those
  // assets are themselves consumers). Gives are computed from a SNAPSHOT of the
  // base allocation so the result is order-independent; transfers conserve the
  // total (what a consumer gives, the assets get).
  const baseSnapshot = new Map(valueByArtifact);
  const creditEarned = new Map<string, number>();
  const directConsumes = new Map<string, string[]>();
  for (const e of composition.edges) {
    if (!directConsumes.has(e.from)) directConsumes.set(e.from, []);
    directConsumes.get(e.from)!.push(e.to);
  }
  for (const { art } of tagged) {
    const ups = directConsumes.get(art.id) ?? [];
    if (ups.length === 0) continue;
    const give = (baseSnapshot.get(art.id) ?? 0) * UPSTREAM_CREDIT;
    if (give <= 0) continue;
    const per = give / ups.length;
    valueByArtifact.set(art.id, (valueByArtifact.get(art.id) ?? 0) - give);
    for (const up of ups) {
      creditEarned.set(up, (creditEarned.get(up) ?? 0) + per);
      valueByArtifact.set(up, (valueByArtifact.get(up) ?? 0) + per);
    }
  }

  // ---- assemble the per-component rows (tagged + credited upstream assets) -----
  const refByArtifact = new Map(tagged.map(({ ref, art }) => [art.id, ref.refId]));
  const rows: ComponentValue[] = [];
  for (const [artifactId, value] of valueByArtifact) {
    const art = resolveArtifact(artifactId);
    if (!art) continue;
    rows.push({
      refId: refByArtifact.get(artifactId) ?? null,
      artifactId,
      tab: art.tab,
      title: art.title,
      value: round2(value),
      sharePct: betValue === 0 ? 0 : Math.round((value / betValue) * 100),
      upstreamCredit: round2(creditEarned.get(artifactId) ?? 0),
      upstream: refByArtifact.get(artifactId) === undefined,
    });
  }
  rows.sort((a, b) => b.value - a.value);

  const sum = rows.reduce((a, r) => a + r.value, 0);
  const residual = round2(betValue - sum);
  return { betValue: round2(betValue), components: rows, reconciles: Math.abs(residual) <= EPS, residual, allocation: method };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pillar roll-up: a pillar's realized total is the Σ of its bets' realized value
 * — so bets reconcile back to the pillar by construction. (Shared-component
 * double-counting across bets is an open question; here each bet's realized value
 * is summed as the user specified.)
 */
export function pillarRollup(
  bets: { bet: BigBet; realized: number }[],
): { total: number; perBet: { id: string; name: string; realized: number; sharePct: number }[] } {
  const total = bets.reduce((a, b) => a + b.realized, 0);
  return {
    total: round2(total),
    perBet: bets.map(({ bet, realized }) => ({
      id: bet.id,
      name: bet.name,
      realized: round2(realized),
      sharePct: total === 0 ? 0 : Math.round((realized / total) * 100),
    })),
  };
}
