/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Shaper for the LLM Gateway tab's read-only usage panel. Turns LiteLLM's
 * aggregate read endpoints into a tenant-TOTAL summary (never per-user, never a
 * key): total requests + tokens, total spend, and how much of the configured
 * budget envelope is used. Pure + defensive — every upstream field is optional
 * and normalised, so a version drift or a missing endpoint degrades to zeros
 * rather than throwing. The route feeds it server-side; the browser only ever
 * sees this shaped, key-free object.
 */

/** LiteLLM `/global/activity` — daily rollup with `sum_*` tenant totals. */
export type RawActivity = {
  sum_api_requests?: number;
  sum_total_tokens?: number;
} | null | undefined;

/** LiteLLM `/global/spend` — a `{spend}` object, an array of them, or a number. */
export type RawSpend =
  | { spend?: number; total_spend?: number }
  | Array<{ spend?: number }>
  | number
  | null
  | undefined;

export type Usage = {
  requests: number;
  tokens: number;
  spendUsd: number;
  budgetUsd: number;
  budgetWindow: string;
  /** 0..100, clamped. 0 when no budget is configured. */
  pctUsed: number;
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Total spend across whatever shape LiteLLM returned. */
export function totalSpend(raw: RawSpend): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return num(raw);
  if (Array.isArray(raw)) return raw.reduce((s, r) => s + num(r?.spend), 0);
  return num(raw.spend ?? raw.total_spend);
}

export function shapeUsage(args: {
  activity: RawActivity;
  spend: RawSpend;
  budgetUsd: number;
  budgetWindow: string;
}): Usage {
  const requests = num(args.activity?.sum_api_requests);
  const tokens = num(args.activity?.sum_total_tokens);
  const spendUsd = totalSpend(args.spend);
  const budgetUsd = num(args.budgetUsd);
  const pctUsed = budgetUsd > 0 ? Math.min(100, Math.round((spendUsd / budgetUsd) * 100)) : 0;
  return {
    requests,
    tokens,
    spendUsd: Math.round(spendUsd * 100) / 100,
    budgetUsd,
    budgetWindow: args.budgetWindow || 'weekly',
    pctUsed,
  };
}
