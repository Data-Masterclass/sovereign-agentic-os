/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Shapers for the LLM Gateway tab's read-only usage panel.
 *
 * Two independent, honest sources:
 *   • ACTIVITY (requests + tokens): LiteLLM `/global/activity` — LiteLLM meters
 *     these reliably regardless of pricing.
 *   • SPEND (last 7 days, EUR): the OS's own run-summary traces (`costUsd`,
 *     priced at run time via `effectiveModelPrices()` — the EUR price book).
 *     NOT LiteLLM's `/global/spend`: LiteLLM prices only models in ITS price
 *     map, so self-hosted routes meter $0 forever — a fake zero. The traces are
 *     the same source (and the same prices) the Monitoring tiles use, so the
 *     two tabs agree by construction.
 *
 * Pure + defensive — every upstream field is optional and normalised. Unpriced
 * is surfaced as null ("—"), never fabricated as 0.
 */

/** LiteLLM `/global/activity` — tenant totals. Older builds expose top-level
 *  `sum_*`; current builds return a `daily_data[]` rollup we sum ourselves. We
 *  handle BOTH so a version drift can't silently zero the panel. */
export type RawActivity = {
  sum_api_requests?: number;
  sum_total_tokens?: number;
  daily_data?: Array<{ api_requests?: number; total_tokens?: number }>;
} | null | undefined;

/** The 7-day tenant spend window (matches the Monitoring telemetry window). */
export const SPEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type Activity = { requests: number; tokens: number };

export type WeeklySpend = {
  /** Runs inside the 7-day window. */
  runs: number;
  /** Runs that carried a priced cost (models present in the EUR price book). */
  pricedRuns: number;
  /** Total tokens across the window's runs (where the backend reported usage). */
  tokens: number;
  /**
   * EUR spend over the window. `0` only when there were NO runs (a true zero);
   * `null` when runs exist but none is priced (unpriced ≠ free — show "—").
   */
  spendEur: number | null;
};

/** The full shaped payload `/api/gateway/usage` returns to the tab. */
export type GatewayUsage = {
  /** LiteLLM 30-day activity totals; null = the gateway did not answer. */
  activity: Activity | null;
  weekly: WeeklySpend & {
    /** False when NEITHER trace source answered — spend is unknown, not 0. */
    telemetryOk: boolean;
  };
  /** Configured budget envelope (0 = none set — render the honest empty state). */
  budgetUsd: number;
  budgetWindow: string;
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Tenant activity totals across whatever shape LiteLLM returned. */
export function shapeActivity(activity: RawActivity): Activity {
  // Prefer the top-level tenant sums; fall back to summing the daily rollup
  // (the shape current LiteLLM returns for `/global/activity`).
  const daily = Array.isArray(activity?.daily_data) ? activity!.daily_data! : [];
  const requests =
    num(activity?.sum_api_requests) || daily.reduce((s, d) => s + num(d?.api_requests), 0);
  const tokens =
    num(activity?.sum_total_tokens) || daily.reduce((s, d) => s + num(d?.total_tokens), 0);
  return { requests, tokens };
}

/**
 * Fold run-summary trace records into the tenant's 7-day spend. `costUsd` is the
 * run-time EUR cost (priced via the platform price book — the field name is
 * historical). Records outside `[nowMs - 7d, nowMs]` are excluded; an unpriced
 * run counts toward `runs`/`tokens` but never toward `spendEur`.
 */
export function weeklyRunSpend(
  records: ReadonlyArray<{ at: number; costUsd?: number; tokens?: number }>,
  nowMs: number,
): WeeklySpend {
  const from = nowMs - SPEND_WINDOW_MS;
  let runs = 0;
  let pricedRuns = 0;
  let tokens = 0;
  let sum = 0;
  for (const r of records) {
    if (!Number.isFinite(r.at) || r.at < from || r.at > nowMs) continue;
    runs += 1;
    if (Number.isFinite(r.tokens)) tokens += r.tokens as number;
    if (Number.isFinite(r.costUsd)) {
      pricedRuns += 1;
      sum += r.costUsd as number;
    }
  }
  const spendEur = runs === 0 ? 0 : pricedRuns > 0 ? Math.round(sum * 100) / 100 : null;
  return { runs, pricedRuns, tokens, spendEur };
}
