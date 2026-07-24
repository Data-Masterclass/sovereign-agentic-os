/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Pure telemetry rollups for the redesigned Monitor tiles (no IO, no server-only)
 * so the 7-day aggregation is unit-testable. `adapters/agent-telemetry.ts` feeds
 * these RAW run records from Langfuse + the in-process governed ring; the server
 * half never does maths the tests can't reach.
 *
 * A "run record" here is the flattened, source-agnostic shape both sources map to
 * (see `RawRun`): one recorded agent step/trace with a timestamp, a health verdict,
 * and optional cost/token metrics. The rollup is deliberately additive: an absent
 * metric contributes 0, never a fake number.
 */

export type RunHealth = 'ok' | 'warn' | 'error';

/** One recorded run/step, mapped from Langfuse OR the governed ring. */
export type RawRun = {
  id: string;
  /** ms epoch — the caller normalises ISO/epoch before it reaches the rollup. */
  at: number;
  health: RunHealth;
  costUsd?: number;
  tokens?: number;
};

/** The compact per-agent telemetry a tile shows (last 7 days). */
export type AgentTelemetry = {
  costUsd: number;
  tokens: number;
  /** Runs in the window. */
  runs: number;
  /** ms epoch of the most recent run in the window, or null. */
  lastRunAt: number | null;
  warnings: number;
  errors: number;
  /** Overall dot: error > warn > ok; grey handled by the caller when runs===0. */
  overall: RunHealth;
};

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Roll a bag of raw runs into the 7-day tile telemetry. Runs OUTSIDE the window are
 * ignored (the caller may pass a wider bag). Cost/tokens sum only over kept runs.
 * `overall` is the worst verdict seen; with zero kept runs everything is 0/null and
 * `overall` is 'ok' (the tile shows grey/"no telemetry" from runs===0, not here).
 */
export function rollupAgentTelemetry(runs: readonly RawRun[], nowMs: number): AgentTelemetry {
  const from = nowMs - WINDOW_MS;
  let costUsd = 0;
  let tokens = 0;
  let count = 0;
  let warnings = 0;
  let errors = 0;
  let lastRunAt: number | null = null;
  for (const r of runs) {
    if (!Number.isFinite(r.at) || r.at < from || r.at > nowMs) continue;
    count += 1;
    if (Number.isFinite(r.costUsd)) costUsd += r.costUsd as number;
    if (Number.isFinite(r.tokens)) tokens += r.tokens as number;
    if (r.health === 'warn') warnings += 1;
    else if (r.health === 'error') errors += 1;
    if (lastRunAt === null || r.at > lastRunAt) lastRunAt = r.at;
  }
  const overall: RunHealth = errors > 0 ? 'error' : warnings > 0 ? 'warn' : 'ok';
  return { costUsd, tokens, runs: count, lastRunAt, warnings, errors, overall };
}

/** Per-dataset quality/health rollup for a Data tile. */
export type DatasetTelemetry = {
  /** Executable DQ checks that passed / failed (legacy free-text intentions are `checksNotRun`). */
  checksPassing: number;
  checksFailing: number;
  checksNotRun: number;
  warnings: number;
  errors: number;
  overall: RunHealth;
};

/** One resolved data-quality check verdict fed to the rollup. */
export type CheckVerdict = 'pass' | 'fail' | 'not_run';

/**
 * Roll dataset signals into tile telemetry. `checks` are the resolved DQ verdicts;
 * `stalenessWarn`/`pipelineError` are booleans the server derives from freshness +
 * build state (a stale-but-built dataset is a warning, a failing DQ or never-built
 * gold that should exist is an error). Overall = error > warn > ok.
 */
export function rollupDatasetTelemetry(
  checks: readonly CheckVerdict[],
  flags: { stalenessWarn?: boolean; pipelineError?: boolean } = {},
): DatasetTelemetry {
  let checksPassing = 0;
  let checksFailing = 0;
  let checksNotRun = 0;
  for (const c of checks) {
    if (c === 'pass') checksPassing += 1;
    else if (c === 'fail') checksFailing += 1;
    else checksNotRun += 1;
  }
  const errors = (checksFailing > 0 ? 1 : 0) + (flags.pipelineError ? 1 : 0);
  const warnings = flags.stalenessWarn ? 1 : 0;
  const overall: RunHealth = errors > 0 ? 'error' : warnings > 0 ? 'warn' : 'ok';
  return { checksPassing, checksFailing, checksNotRun, warnings, errors, overall };
}

/** One resolved DQ rule verdict, mirrored from `lib/data/dq` CheckResult (read-only). */
export type DqCheckResult = {
  id: string;
  label: string;
  status: CheckVerdict;
  /** Violation count for pass/fail; null when not run. */
  violations: number | null;
  reason?: string;
};

/** The DQ summary a dataset tile + detail window need (from the persisted last run). */
export type DqSummary = {
  /** Total rules that produced a verdict or intention. */
  rules: number;
  passing: number;
  /** Rules that ran and violated (the red count the tile surfaces). */
  violated: number;
  notRun: number;
  /** The violated rules, for the "which rules" list. */
  violatedRules: { id: string; label: string; violations: number | null }[];
  /** True when a DQ run has ever been recorded (else the tile shows neutral). */
  hasRun: boolean;
};

/**
 * Fold the LAST persisted DQ run's per-rule results into the tile/detail summary.
 * `hasRun=false` ⇒ no DQ run recorded (tile stays neutral, never a fake green). A
 * rule with status 'fail' is "violated"; 'pass' is passing; anything else not-run.
 */
export function summarizeDq(results: readonly DqCheckResult[] | null): DqSummary {
  if (!results || results.length === 0) {
    return { rules: 0, passing: 0, violated: 0, notRun: 0, violatedRules: [], hasRun: results !== null };
  }
  let passing = 0;
  let violated = 0;
  let notRun = 0;
  const violatedRules: DqSummary['violatedRules'] = [];
  for (const r of results) {
    if (r.status === 'pass') passing += 1;
    else if (r.status === 'fail') {
      violated += 1;
      violatedRules.push({ id: r.id, label: r.label, violations: r.violations });
    } else notRun += 1;
  }
  return { rules: results.length, passing, violated, notRun, violatedRules, hasRun: true };
}

/**
 * Bucket runs into a compact per-day series for a 7-day sparkline (oldest→newest),
 * summing a chosen metric per whole UTC day. Returns exactly `days` buckets so the
 * chart width is stable even with gaps (a quiet day is 0, not missing).
 */
export function dailySeries(
  runs: readonly RawRun[],
  nowMs: number,
  pick: (r: RawRun) => number,
  days = 7,
): { day: number; value: number }[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const startDay = Math.floor((nowMs - (days - 1) * dayMs) / dayMs);
  const out = Array.from({ length: days }, (_, i) => ({ day: startDay + i, value: 0 }));
  for (const r of runs) {
    if (!Number.isFinite(r.at)) continue;
    const d = Math.floor(r.at / dayMs);
    const idx = d - startDay;
    if (idx < 0 || idx >= days) continue;
    const v = pick(r);
    if (Number.isFinite(v)) out[idx].value += v;
  }
  return out;
}
