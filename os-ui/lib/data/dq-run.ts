/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { DataCheck } from './dataset-schema.ts';
import {
  aggregateBadge,
  compileCheck,
  DqError,
  ruleLabel,
  verdictFromViolations,
  type CheckResult,
  type QualityBadge,
} from './dq.ts';

/**
 * Execute a dataset's data-quality checks through the governed query path and
 * aggregate an honest badge.
 *
 * Each structured rule is compiled to a COUNT-of-violations SQL (`lib/data/dq.ts`) and
 * run via the injected `queryFn` — the caller wires `queryRun(sql, principal)` with the
 * OWNER principal from `builtLayerFqn`, so a private dataset's `personal_<uid>` table is
 * read AS its owner and Trino's OPA plugin governs it. A rule that can't compile
 * (free-text intention, missing args) or whose table isn't materialized (`fqn` null, or
 * the query throws) is reported `not_run` — NEVER a fake pass. Pure orchestration (the
 * query executor is injected) so it is unit-tested without a live Trino.
 */

export type RunDeps = {
  /** null ⇒ nothing built yet (no physical table) ⇒ every rule is "not run". */
  fqn: string | null;
  /** The governed executor — bound to the owner principal by the route. */
  queryFn: (sql: string) => Promise<{ rows: string[][] }>;
};

export type QualityReport = {
  fqn: string | null;
  ranAt: string;
  badge: QualityBadge;
  results: CheckResult[];
};

/** Read the single integer a violations-count SELECT returns (row 0, col 0). */
function firstCount(rows: string[][]): number {
  const raw = rows?.[0]?.[0];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function runQualityChecks(
  checks: DataCheck[],
  deps: RunDeps,
  now: () => string = () => new Date().toISOString(),
): Promise<QualityReport> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    const label = ruleLabel(check);
    // No physical table yet — honest "not run" for every rule.
    if (!deps.fqn) {
      results.push({ id: check.id, label, status: 'not_run', violations: null, reason: 'no built layer to check yet' });
      continue;
    }
    let sql: string;
    try {
      sql = compileCheck(check, deps.fqn).sql;
    } catch (e) {
      const reason = e instanceof DqError ? e.message : (e as Error).message;
      results.push({ id: check.id, label, status: 'not_run', violations: null, reason });
      continue;
    }
    try {
      const res = await deps.queryFn(sql);
      const violations = firstCount(res.rows);
      results.push({ id: check.id, label, status: verdictFromViolations(violations), violations });
    } catch (e) {
      // The table isn't queryable (not materialized / wiped / offline) — not a pass.
      results.push({ id: check.id, label, status: 'not_run', violations: null, reason: (e as Error).message });
    }
  }

  return { fqn: deps.fqn, ranAt: now(), badge: aggregateBadge(results), results };
}
