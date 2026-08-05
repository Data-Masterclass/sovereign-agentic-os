/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Pure, framework-free helpers for the Science tab's Simple surfaces — the business-language
 * metric phrasing, the governed-preview row → feature-vector mapping, and the usage
 * buckets → chart series shaping. Kept here (no React, no server imports) so the interpretation
 * logic is unit-tested independently of the components that render it. NOTHING is fabricated:
 * every function returns null / an empty result when the real input is absent.
 */

import type { ModelUsage, UsageBucketKind } from './types';

/**
 * Phrase the REAL trained metric in business language, computed ONLY from a real value.
 * Returns null when there is no metric (so the caller renders nothing rather than a lie).
 *
 *   classification auc → "On held-back data the model ranked positives above negatives NN% of the time"
 *   regression rmse    → "Typical prediction error: ±NN"
 * Any other metric falls back to an honest "<name> NN" phrasing.
 */
export function phraseMetric(metricName: string | undefined, value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const name = (metricName ?? '').toLowerCase();
  if (name === 'auc' || name === 'roc_auc') {
    const pct = Math.round(value * 100);
    return `On held-back data the model ranked positives above negatives ${pct}% of the time.`;
  }
  if (name === 'rmse' || name === 'mae') {
    // Round to a sensible precision without inventing a unit we don't know.
    const n = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
    return `Typical prediction error: ±${n}.`;
  }
  const n = Math.round(value * 1000) / 1000;
  return `${metricName ?? 'metric'} ${n}.`;
}

/**
 * Map a governed-preview row (values in COLUMN order) to a feature vector for `predict`.
 * The preview returns `{ columns: string[], rows: string[][] }`; features come from the model
 * spec. Non-numeric cells (dates, strings) coerce to 0 honestly — the runtime scores numeric
 * inputs — and a display copy keeps the raw cell text for the "what you picked" summary.
 */
export function rowToFeatures(
  columns: string[],
  row: string[],
  features: string[],
): { vector: Record<string, number>; display: Record<string, string> } {
  const index = new Map<string, number>();
  columns.forEach((c, i) => index.set(c, i));
  const vector: Record<string, number> = {};
  const display: Record<string, string> = {};
  for (const f of features) {
    const i = index.get(f);
    const cell = i !== undefined ? row[i] : undefined;
    display[f] = cell ?? '';
    const n = Number(cell);
    vector[f] = Number.isFinite(n) ? n : 0;
  }
  return { vector, display };
}

/** A verdict phrased for a business user from a governed predict result's score + band. */
export function phraseVerdict(score: number | undefined, band: string | undefined): { headline: string; detail: string } | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const pct = Math.round(score * 100);
  const label =
    band === 'high' ? 'High' : band === 'low' ? 'Low' : band === 'medium' ? 'Medium' : null;
  const headline = label ? `${label} — ${pct}%` : `Score ${pct}%`;
  const detail =
    band === 'high'
      ? 'A strong signal for this outcome — worth acting on, but it is a probability, not a certainty.'
      : band === 'low'
      ? 'A weak signal for this outcome on this example.'
      : 'A middling signal — treat it as one input, not a decision on its own.';
  return { headline, detail };
}

/** The ordered band keys for a histogram of the given kind (d0..d9 or b0..b9). */
export function bandKeys(kind: UsageBucketKind): string[] {
  const p = kind === 'decile' ? 'd' : 'b';
  return Array.from({ length: 10 }, (_, i) => `${p}${i}`);
}

/** Human label for a band key on the chart axis. */
export function bandLabel(kind: UsageBucketKind, key: string): string {
  const i = Number(key.slice(1));
  if (!Number.isFinite(i)) return key;
  if (kind === 'decile') {
    const lo = (i / 10).toFixed(1);
    const hi = ((i + 1) / 10).toFixed(1);
    return `${lo}–${hi}`;
  }
  return `band ${i}`;
}

export type UsageSeries = {
  /** Sorted day keys (the x-axis when stacked by day). */
  days: string[];
  /** Ordered band keys (the histogram buckets). */
  bands: string[];
  /** Total ALLOWED scored calls per band (summed across days) — the headline distribution. */
  totalsByBand: number[];
  /** Grand total of scored calls represented (0 → nothing to chart). */
  scored: number;
};

/**
 * Shape a ModelUsage's day×band buckets into an ordered series for a minimal distribution
 * chart. Returns `scored: 0` (empty) when no allowed call has been scored — the caller then
 * renders an honest empty state instead of an empty chart. Never fabricates buckets.
 */
export function usageToSeries(usage: ModelUsage | undefined): UsageSeries {
  const bands = bandKeys(usage?.bandKind ?? 'decile');
  if (!usage || !usage.buckets) return { days: [], bands, totalsByBand: bands.map(() => 0), scored: 0 };
  const days = Object.keys(usage.buckets).sort();
  const totals = new Map<string, number>();
  for (const day of days) {
    const perBand = usage.buckets[day] ?? {};
    for (const [k, v] of Object.entries(perBand)) {
      if (typeof v === 'number' && Number.isFinite(v)) totals.set(k, (totals.get(k) ?? 0) + v);
    }
  }
  const totalsByBand = bands.map((b) => totals.get(b) ?? 0);
  const scored = totalsByBand.reduce((a, b) => a + b, 0);
  return { days, bands, totalsByBand, scored };
}
