/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        monitoring
 * FEATURE:    Tenant spend vs the billing ENVELOPE — usage percentage, a six-point
 *             trend and the hard-stop indicator, plus the STACKIT premium ceiling.
 * USER STORY: As an admin watching the tenant I want to see how much of the monthly
 *             envelope is spent and whether the premium ceiling is about to bite, in
 *             the same place I watch everything else that is running.
 * ARCHITECTURE:
 *   - Pure math, no I/O, so it is unit-testable (see spend.test.ts). The LiteLLM
 *     read lives in the route (`app/api/platform-admin/billing`), which stays
 *     admin-gated by `adminCtx()`; offline we fall back to a deterministic mock so
 *     the surface renders with no gateway.
 *   - Observation, not configuration: the envelope is DISPLAY-ONLY (see the comment
 *     on `litellmBudgetUsd` in `core/kernel/config.ts`) — real budget enforcement is
 *     LiteLLM's own key budget. That is why this lives in Monitoring and not Platform.
 *   - Governance allocates the per-key/domain/agent sub-caps WITHIN the envelope.
 *   - THE HONESTY GATE (2026-11-18, review H1). `offlineSpend` was called UNCONDITIONALLY by both
 *     platform-admin routes, which then stamped `source: 'offline-mock'` — so on the live cluster
 *     the envelope tile showed 62% of the configured envelope as spend, invented from the
 *     envelope itself, and the Platform overview raised a REAL "Spend at N% of envelope" alert
 *     off it. `tenantSpendView` is now the ONE door both routes call, and it consults the kernel
 *     predicate: refused ⇒ `source: 'unavailable'` with NULL figures and an empty trend. Null,
 *     not zero: "we cannot read spend" and "nothing has been spent" are different facts and the
 *     tile must not be able to show the second when it means the first.
 */
import { offlineMockAllowed, OFFLINE_MOCK_HINT } from '@core/kernel/offline-mock';

export type BillingView = {
  envelopeEUR: number;
  premiumCapEUR: number;
  /** NULL when spend could not be read. Never 0 for that reason — see the header. */
  spendEUR: number | null;
  premiumSpendEUR: number | null;
  pctUsed: number | null;
  premiumPctUsed: number | null;
  hardStop: boolean;
  premiumHardStop: boolean;
  /** 6-point spend trend (EUR), oldest→newest. Empty when spend could not be read. */
  trend: number[];
  source: 'litellm' | 'offline-mock' | 'unavailable';
  /** Set with `source: 'unavailable'` — why there are no figures. */
  reason?: string;
};

/** Deterministic offline spend so the envelope view is demonstrable with no LiteLLM. */
export function offlineSpend(envelopeEUR: number): { spendEUR: number; premiumSpendEUR: number; trend: number[] } {
  const spendEUR = Math.round(envelopeEUR * 0.62);
  const premiumSpendEUR = Math.round(spendEUR * 0.18);
  const trend = [0.31, 0.4, 0.46, 0.52, 0.58, 0.62].map((f) => Math.round(envelopeEUR * f));
  return { spendEUR, premiumSpendEUR, trend };
}

/**
 * No figures, and nothing that could be mistaken for one. The envelope and the cap are the
 * tenant's own CONFIGURATION (not a reading), so they are still reported — a reader needs to see
 * what the ceiling is even when the OS cannot say how close to it we are.
 */
export function unavailableBilling(envelopeEUR: number, premiumCapEUR: number): BillingView {
  return {
    envelopeEUR,
    premiumCapEUR,
    spendEUR: null,
    premiumSpendEUR: null,
    pctUsed: null,
    premiumPctUsed: null,
    hardStop: false,
    premiumHardStop: false,
    trend: [],
    source: 'unavailable',
    reason:
      'Spend cannot be read: LiteLLM reports no live figures to this deployment and no demo ' +
      `figures are issued. ${OFFLINE_MOCK_HINT}`,
  };
}

/**
 * THE one door both platform-admin routes use for the envelope view. It decides; the routes
 * render. A caller with REAL figures (a LiteLLM read, when one is wired) passes them in and the
 * gate is not consulted at all — the gate governs only the invented fallback.
 */
export function tenantSpendView(
  envelopeEUR: number,
  premiumCapEUR: number,
  live?: { spendEUR: number; premiumSpendEUR: number; trend: number[] },
): BillingView {
  if (live) return billingView({ envelopeEUR, premiumCapEUR, ...live, source: 'litellm' });
  if (!offlineMockAllowed()) return unavailableBilling(envelopeEUR, premiumCapEUR);
  return billingView({ envelopeEUR, premiumCapEUR, ...offlineSpend(envelopeEUR), source: 'offline-mock' });
}

export function billingView(input: {
  envelopeEUR: number;
  premiumCapEUR: number;
  spendEUR: number;
  premiumSpendEUR: number;
  trend: number[];
  source: BillingView['source'];
}): BillingView {
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const pctUsed = pct(input.spendEUR, input.envelopeEUR);
  const premiumPctUsed = pct(input.premiumSpendEUR, input.premiumCapEUR);
  return {
    envelopeEUR: input.envelopeEUR,
    premiumCapEUR: input.premiumCapEUR,
    spendEUR: input.spendEUR,
    premiumSpendEUR: input.premiumSpendEUR,
    pctUsed,
    premiumPctUsed,
    hardStop: input.spendEUR >= input.envelopeEUR,
    premiumHardStop: input.premiumSpendEUR >= input.premiumCapEUR,
    trend: input.trend,
    source: input.source,
  };
}
