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

/**
 * STUB for the Strategy roll-up (strategy-golden-path.md): value-vs-target,
 * adoption counts, promoted/certified this period, and a few Big Bets. Scoped to
 * one domain. Replace with the real Strategy adapter at consolidation.
 */
export function domainPulseStub(domain: string): DomainPulse {
  // A fresh tenant has no activity yet — the cockpit shows an empty pulse until
  // real Strategy/Big-Bets artifacts exist (e.g. via the Northpeak seed).
  return {
    source: 'mock',
    domain,
    valuePct: 0,
    valueLabel: `Value created vs ${new Date().getUTCFullYear()} target`,
    activeCreators: 0,
    activeBuilders: 0,
    promotedThisPeriod: 0,
    certifiedThisPeriod: 0,
    bets: [],
  };
}

/**
 * STUB for the Monitoring signals (monitoring-golden-path.md): red items for the
 * viewer's scope + spend vs cap. Scoped to the viewer. Replace with the real
 * Monitoring adapter at consolidation.
 */
export function healthCostStub(_viewerId: string, _domain: string): HealthCost {
  // A fresh tenant has no agents/pipelines running — nothing red and no spend
  // until real activity exists (e.g. via the Northpeak seed).
  void _viewerId;
  void _domain;
  return {
    source: 'mock',
    redItems: [],
    spendUsd: 0,
    capUsd: 0,
    spendPct: 0,
  };
}
