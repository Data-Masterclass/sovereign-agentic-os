/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Dataset } from './dataset-schema.ts';
import { runQualityChecks } from './dq-run.ts';
import { healthScore, aggregateBadge, type CheckResult, type QualityBadge } from './dq.ts';
import { parseDescribe } from './profile.ts';
import { evaluateMonitors, schemaFingerprint, type MonitorConfig } from './dq-monitors.ts';
import { ensureHydrated, recordRun, monitorHistory, type DqRunRecord } from './dq-results.ts';

/**
 * The GOVERNED, server-side DQ run for ONE dataset — the single place that runs a
 * dataset's checks AND its heuristic monitors, then persists the result to the durable
 * time-series. Shared by the per-dataset checks route (`action:'run'`) and the scheduled
 * `POST /api/data/dq/run-all` so the two can never drift.
 *
 * The caller injects a `queryFn` already bound to the OWNER principal (from
 * `builtLayerFqn`) — this module NEVER decides identity; it just runs governed SQL. The
 * HONESTY CONTRACT is preserved end to end: no built layer ⇒ every rule + monitor is
 * `not_run`; a row-count / schema probe that throws degrades that observation to null so
 * the monitor stays honestly `not_run` rather than inventing a pass.
 */

export type DqRunOutcome = {
  fqn: string | null;
  ranAt: string;
  badge: QualityBadge;
  results: CheckResult[];
  health: ReturnType<typeof healthScore>;
  rowCount: number | null;
  schemaFingerprint: string | null;
};

/**
 * A NEW failure — the alert trigger. Fires only on a fresh transition INTO failing
 * (prior badge was not `failing`, or there was no prior run) so the scheduled cron
 * notifies once per incident, not on every run while a dataset stays broken. Honest:
 * a run that measured nothing (`unknown`) is never treated as a recovery or a failure.
 */
export function isNewFailure(current: QualityBadge, prior: QualityBadge | null): boolean {
  return current === 'failing' && prior !== 'failing';
}

export type DqRunServerDeps = {
  /** The resolved built-layer target, or null when nothing is materialised. */
  fqn: string | null;
  /** Governed executor, bound to the owner principal by the caller. */
  queryFn: (sql: string) => Promise<{ rows: string[][] }>;
  /** Audit: who ran this (the signed-in user, or the cron service principal). */
  ownerId: string;
  now?: () => string;
  /** For tests: override the persisted history the monitors learn from. */
  history?: ReturnType<typeof monitorHistory>;
  /**
   * OPTIONAL best-effort OpenMetadata result-appender (Phase 2 DQ write-back). When the
   * caller injects it (OM connected + `openmetadata.dqWriteback.enabled`), each governed
   * run's per-rule verdict is appended to the matching OM TestCase time-series so OM's DQ
   * dashboard trend fills for free. It is CALLED after the OS-side result is persisted and
   * is NON-BLOCKING by contract: it must never throw and never fake success — an
   * unreachable / out-of-range OM appends nothing and the DQ run still succeeds. Absent ⇒
   * zero OM coupling.
   */
  omAppend?: (results: CheckResult[], ranAt: string) => Promise<void>;
};

/** Read the current row count via the same governed executor. Throws-safe ⇒ null. */
async function probeRowCount(fqn: string, queryFn: DqRunServerDeps['queryFn']): Promise<number | null> {
  try {
    const res = await queryFn(`select count(*) as v from ${fqn}`);
    const n = Number(res.rows?.[0]?.[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Snapshot the column set via `DESCRIBE`. Throws-safe ⇒ null. */
async function probeSchema(fqn: string, queryFn: DqRunServerDeps['queryFn']): Promise<string | null> {
  try {
    const res = await queryFn(`describe ${fqn}`);
    const cols = parseDescribe({ engine: '', tables: [], columns: [], rows: res.rows, rowCount: res.rows.length });
    return cols.length > 0 ? schemaFingerprint(cols) : null;
  } catch {
    return null;
  }
}

/**
 * Run a dataset's checks + enabled monitors and persist ONE `DqRunRecord`. Returns the
 * full outcome (merged results + honest health) so the route can hand it back to the UI.
 * Persistence is best-effort — a mirror hiccup never fails the run the caller just did.
 */
export async function runAndRecord(dataset: Dataset, deps: DqRunServerDeps): Promise<DqRunOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const report = await runQualityChecks(dataset.checks ?? [], { fqn: deps.fqn, queryFn: deps.queryFn }, now);

  // Observe row-count + schema for the monitors (only when there's a physical table).
  let rowCount: number | null = null;
  let fingerprint: string | null = null;
  if (deps.fqn) {
    rowCount = await probeRowCount(deps.fqn, deps.queryFn);
    fingerprint = await probeSchema(deps.fqn, deps.queryFn);
  }

  // Monitors evaluate against the persisted history for THIS dataset (owner default-ON).
  let history = deps.history;
  if (!history) {
    try {
      await ensureHydrated();
      history = monitorHistory(dataset.id);
    } catch {
      history = [];
    }
  }
  const monitorResults = evaluateMonitors(
    history,
    { ranAt: report.ranAt, rowCount, schemaFingerprint: fingerprint },
    dataset.monitors as MonitorConfig | undefined,
  );

  const results = [...report.results, ...monitorResults];
  const badge = aggregateBadge(results);
  const health = healthScore(results, rowCount);

  try {
    await ensureHydrated();
    recordRun({
      datasetId: dataset.id,
      ranAt: report.ranAt,
      badge,
      healthScore: health.score,
      results,
      ranBy: deps.ownerId,
      domain: dataset.domain,
      rowCount,
      schemaFingerprint: fingerprint,
    });
  } catch {
    /* durability is additive — the live outcome is still returned */
  }

  // Best-effort OpenMetadata write-back (Phase 2 DQ) — additive, non-blocking, never
  // fakes success. Absent ⇒ no OM coupling; present ⇒ appends each rule's verdict to its
  // OM TestCase trend. Wrapped so a thrown/rejected appender never fails the DQ run.
  if (deps.omAppend) {
    try {
      await deps.omAppend(results, report.ranAt);
    } catch {
      /* OM enrichment is additive — an append failure never fails the governed DQ run */
    }
  }

  return { fqn: deps.fqn, ranAt: report.ranAt, badge, results, health, rowCount, schemaFingerprint: fingerprint };
}

export type { DqRunRecord };
