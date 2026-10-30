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
 */

export type BillingView = {
  envelopeEUR: number;
  premiumCapEUR: number;
  spendEUR: number;
  premiumSpendEUR: number;
  pctUsed: number;
  premiumPctUsed: number;
  hardStop: boolean;
  premiumHardStop: boolean;
  /** 6-point spend trend (EUR), oldest→newest. */
  trend: number[];
  source: 'litellm' | 'offline-mock';
};

/** Deterministic offline spend so the envelope view is demonstrable with no LiteLLM. */
export function offlineSpend(envelopeEUR: number): { spendEUR: number; premiumSpendEUR: number; trend: number[] } {
  const spendEUR = Math.round(envelopeEUR * 0.62);
  const premiumSpendEUR = Math.round(spendEUR * 0.18);
  const trend = [0.31, 0.4, 0.46, 0.52, 0.58, 0.62].map((f) => Math.round(envelopeEUR * f));
  return { spendEUR, premiumSpendEUR, trend };
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
