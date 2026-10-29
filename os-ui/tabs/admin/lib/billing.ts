/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Cost & Billing adapter — the tenant ENVELOPE (not the operational sub-caps).
 *
 * Platform Admin sets the envelope/plan/budget + the STACKIT premium ceiling;
 * Governance allocates per-key/domain/agent sub-caps WITHIN it; Monitoring
 * watches live spend. This adapter computes usage-vs-envelope with a trend and a
 * hard-stop indicator. Live spend is read from LiteLLM (best-effort) at the
 * route; offline we fall back to a deterministic mock so the cockpit renders.
 *
 * Pure math here (unit-testable); the LiteLLM fetch lives in the route.
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
