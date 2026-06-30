/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Cross-tab feed STUBS for the `kind` gate — Domain pulse (from **Strategy**)
 * and Health & cost (from **Monitoring**). Those tabs are built on parallel
 * branches; per the build plan Home stubs their feeds behind the adapter now and
 * reconciles at consolidation. CRITICAL: this is the SINGLE source of these
 * numbers for Home, returned with an explicit `source: 'mock'` marker, so:
 *
 *   • the UI is HONEST that the figure is a local stand-in (no fake "live"), and
 *   • there is NO recomputation drift — Home reads exactly what the adapter
 *     returns and never re-derives it. At consolidation, swap the two functions
 *     below for `import { domainPulse } from '@/lib/strategy'` /
 *     `import { healthCost } from '@/lib/monitoring'` returning the SAME shape;
 *     the Home page, tests and components do not change.
 *
 * Deterministic per domain so the same viewer always sees a stable cockpit.
 */

export type FeedSource = 'live' | 'mock';

export type DomainPulse = {
  source: FeedSource;
  domain: string;
  /** Value created vs target this period (percent, 0–100+). */
  valuePct: number;
  valueLabel: string;
  activeCreators: number;
  activeBuilders: number;
  promotedThisPeriod: number;
  certifiedThisPeriod: number;
  bets: { name: string; status: 'on-track' | 'at-risk' | 'planned'; pct: number }[];
};

export type HealthCost = {
  source: FeedSource;
  /** Anything red for the viewer's agents/pipelines. */
  redItems: { name: string; detail: string }[];
  spendUsd: number;
  capUsd: number;
  /** Spend as a fraction of cap (0–1+), for the gauge. */
  spendPct: number;
};

// Small deterministic hash so a domain maps to stable-but-distinct figures.
function seedFor(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000;
}

/**
 * STUB for the Strategy roll-up (strategy-golden-path.md): value-vs-target,
 * adoption counts, promoted/certified this period, and a few Big Bets. Scoped to
 * one domain. Replace with the real Strategy adapter at consolidation.
 */
export function domainPulseStub(domain: string): DomainPulse {
  const s = seedFor(domain);
  const valuePct = 45 + (s % 50); // 45–94%
  return {
    source: 'mock',
    domain,
    valuePct,
    valueLabel: `Value created vs ${new Date().getUTCFullYear()} target`,
    activeCreators: 3 + (s % 7),
    activeBuilders: 1 + (s % 3),
    promotedThisPeriod: 2 + (s % 6),
    certifiedThisPeriod: 1 + (s % 3),
    bets: [
      { name: 'Reduce churn', status: valuePct >= 60 ? 'on-track' : 'at-risk', pct: valuePct },
      { name: 'Faster quote-to-cash', status: 'planned', pct: 15 + (s % 20) },
    ],
  };
}

/**
 * STUB for the Monitoring signals (monitoring-golden-path.md): red items for the
 * viewer's scope + spend vs cap. Scoped to the viewer. Replace with the real
 * Monitoring adapter at consolidation.
 */
export function healthCostStub(viewerId: string, domain: string): HealthCost {
  const s = seedFor(`${viewerId}:${domain}`);
  const spendUsd = 40 + (s % 160); // $40–$199
  const capUsd = 250;
  const red = s % 4 === 0 ? [{ name: 'churn-model latency', detail: 'p95 1.8s — above the 1s SLO' }] : [];
  return {
    source: 'mock',
    redItems: red,
    spendUsd,
    capUsd,
    spendPct: Math.round((spendUsd / capUsd) * 100) / 100,
  };
}
