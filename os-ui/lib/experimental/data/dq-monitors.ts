/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { CheckResult, CheckStatus } from './dq.ts';

/**
 * Heuristic / statistical DATA-QUALITY MONITORS (Data tab · Validate stage · Phase 1).
 *
 * Monte-Carlo's insight is that freshness / volume / schema give you coverage WITHOUT
 * writing any rules. These three monitors are the sovereign, explainable version of that:
 * pure functions over the PERSISTED run history (`dq-results.ts`), no ML, no black box —
 * a mean ± k·σ band, a cadence gap, and a column-set diff, each of which a human can read
 * and re-derive by hand.
 *
 *   - freshness = now − last-loaded vs an expected cadence learned from the run gaps.
 *   - volume    = the current row-count vs a mean ± k·σ band over recent row-counts.
 *   - schema    = the current column set vs the last snapshot (adds/drops/type-changes).
 *
 * They compile to the SAME governed count-of-violations / comparison contract the rules
 * use: each returns a {@link CheckResult} (`pass` | `fail` | `not_run`) so it feeds the
 * existing `healthScore()` / `aggregateBadge()` untouched. The HONESTY CONTRACT is kept:
 * a monitor with too little history to judge is `not_run` (with a reason) — NEVER a fake
 * pass. Pure module (history-in / verdict-out, no engine, no network) so every band edge
 * is unit-tested, mirroring `dq.ts` / `dq-suggest.ts`.
 */

/** The three heuristic monitor kinds — stable identifiers used across the run + UI. */
export type MonitorKind = 'freshness' | 'volume' | 'schema';

/** The default-ON toggle set. All three are on unless the owner turns one off. */
export const MONITOR_KINDS: MonitorKind[] = ['freshness', 'volume', 'schema'];

/** Which monitors are enabled for a dataset. Absent members default to ON (honest default). */
export type MonitorConfig = Partial<Record<MonitorKind, boolean>>;

export function monitorEnabled(config: MonitorConfig | undefined, kind: MonitorKind): boolean {
  return config?.[kind] !== false; // undefined ⇒ on (default-ON), only an explicit false disables.
}

/** A prior run's shape the monitors compare against (a projection of `DqRunRecord`). */
export type MonitorHistoryPoint = {
  ranAt: string;
  /** Row count observed at that run, or null when it wasn't captured. */
  rowCount: number | null;
  /** Sorted "name:type" column set at that run, or null when not captured. */
  schemaFingerprint: string | null;
};

/** The current observation the monitors judge against the history. */
export type MonitorObservation = {
  ranAt: string;
  rowCount: number | null;
  schemaFingerprint: string | null;
};

// A monitor needs at least this many prior points with a value before it will judge — with
// less, the band/cadence is meaningless, so it stays honestly `not_run`.
const MIN_HISTORY = 3;
// The volume band half-width in standard deviations (mean ± K·σ). 3σ ≈ 99.7% under normal.
const VOLUME_K = 3;
// A cadence's tolerated lateness multiple: late only past 1.5× the learned median gap.
const FRESHNESS_SLACK = 1.5;

const MONITOR_LABEL: Record<MonitorKind, string> = {
  freshness: 'freshness',
  volume: 'row volume',
  schema: 'schema stable',
};

/** The synthetic check id a monitor result carries (namespaced so it never collides). */
export function monitorId(kind: MonitorKind): string {
  return `monitor:${kind}`;
}

function result(kind: MonitorKind, status: CheckStatus, over: Partial<CheckResult> = {}): CheckResult {
  return { id: monitorId(kind), label: `monitor:${MONITOR_LABEL[kind]}`, status, violations: null, ...over };
}

/** A stable "name:type,…" fingerprint of a column set (sorted so order never matters). */
export function schemaFingerprint(columns: { name: string; type: string }[]): string {
  return columns
    .map((c) => `${String(c.name).trim()}:${String(c.type).trim()}`)
    .sort()
    .join(',');
}

/** Median of a numeric list (sorted copy — does not mutate). Empty ⇒ null. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * FRESHNESS — is the data arriving on its expected cadence? The cadence is LEARNED from
 * the median gap between prior runs (no config needed); the current gap since the last run
 * violates only past {@link FRESHNESS_SLACK}× that median. Too few runs ⇒ `not_run`.
 */
export function evaluateFreshness(history: MonitorHistoryPoint[], obs: MonitorObservation): CheckResult {
  const times = history.map((h) => Date.parse(h.ranAt)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const now = Date.parse(obs.ranAt);
  if (!Number.isFinite(now) || times.length < MIN_HISTORY) {
    return result('freshness', 'not_run', { reason: 'not enough run history to learn a cadence yet' });
  }
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const cadence = median(gaps);
  if (cadence === null || cadence <= 0) {
    return result('freshness', 'not_run', { reason: 'cadence indeterminate (identical run times)' });
  }
  const last = times[times.length - 1];
  const sinceLast = now - last;
  const budget = cadence * FRESHNESS_SLACK;
  const lateHours = Math.round((sinceLast - cadence) / 3_600_000);
  if (sinceLast > budget) {
    return result('freshness', 'fail', {
      violations: 1,
      reason: `${lateHours}h past the expected ~${Math.round(cadence / 3_600_000)}h cadence`,
    });
  }
  return result('freshness', 'pass', { reason: `on cadence (~${Math.round(cadence / 3_600_000)}h)` });
}

/**
 * VOLUME — is the row count inside its normal band? The band is `mean ± K·σ` over recent
 * row-counts in the history (population σ). The current count outside the band is a fail.
 * No row-count now, or too little history, ⇒ `not_run` (never a fake pass).
 */
export function evaluateVolume(history: MonitorHistoryPoint[], obs: MonitorObservation): CheckResult {
  const counts = history.map((h) => h.rowCount).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (typeof obs.rowCount !== 'number' || !Number.isFinite(obs.rowCount)) {
    return result('volume', 'not_run', { reason: 'no row count captured for this run' });
  }
  if (counts.length < MIN_HISTORY) {
    return result('volume', 'not_run', { reason: 'not enough history to learn a volume band yet' });
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  const sigma = Math.sqrt(variance);
  const lo = Math.max(0, Math.floor(mean - VOLUME_K * sigma));
  const hi = Math.ceil(mean + VOLUME_K * sigma);
  const band = `${lo}–${hi}`;
  if (obs.rowCount < lo || obs.rowCount > hi) {
    return result('volume', 'fail', { violations: 1, reason: `${obs.rowCount} rows outside the expected band ${band}` });
  }
  return result('volume', 'pass', { reason: `${obs.rowCount} rows within band ${band}` });
}

/**
 * SCHEMA — is the column set stable? Compares the current fingerprint to the LAST captured
 * one; any add / drop / type-change is a fail, naming what moved. No prior snapshot (first
 * run) or no fingerprint now ⇒ `not_run` — a baseline can't fail against nothing.
 */
export function evaluateSchema(history: MonitorHistoryPoint[], obs: MonitorObservation): CheckResult {
  if (!obs.schemaFingerprint) {
    return result('schema', 'not_run', { reason: 'no schema snapshot captured for this run' });
  }
  const prior = [...history].reverse().find((h) => !!h.schemaFingerprint)?.schemaFingerprint ?? null;
  if (!prior) {
    return result('schema', 'not_run', { reason: 'no prior schema snapshot to compare against yet' });
  }
  if (prior === obs.schemaFingerprint) {
    return result('schema', 'pass', { reason: 'column set unchanged' });
  }
  const before = new Set(prior.split(',').filter(Boolean));
  const after = new Set(obs.schemaFingerprint.split(',').filter(Boolean));
  const added = [...after].filter((c) => !before.has(c));
  const dropped = [...before].filter((c) => !after.has(c));
  const parts: string[] = [];
  if (added.length) parts.push(`added ${added.map((c) => c.split(':')[0]).join(', ')}`);
  if (dropped.length) parts.push(`dropped/changed ${dropped.map((c) => c.split(':')[0]).join(', ')}`);
  return result('schema', 'fail', { violations: 1, reason: parts.join('; ') || 'column set changed' });
}

/**
 * Evaluate the ENABLED monitors for a dataset against its history + current observation.
 * A disabled monitor is simply omitted (not a `not_run` — the owner opted out). The result
 * list is `CheckResult`s so the caller merges them straight into the rule results before
 * `healthScore()` / `aggregateBadge()` — one honest score over rules AND monitors.
 */
export function evaluateMonitors(
  history: MonitorHistoryPoint[],
  obs: MonitorObservation,
  config?: MonitorConfig,
): CheckResult[] {
  const out: CheckResult[] = [];
  if (monitorEnabled(config, 'freshness')) out.push(evaluateFreshness(history, obs));
  if (monitorEnabled(config, 'volume')) out.push(evaluateVolume(history, obs));
  if (monitorEnabled(config, 'schema')) out.push(evaluateSchema(history, obs));
  return out;
}
