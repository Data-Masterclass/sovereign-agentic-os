/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { DataCheck } from './dataset-schema.ts';

/**
 * The data-quality rule compiler + aggregator (Data tab §DQ).
 *
 * A structured {@link DataCheck} (rule + column + args) compiles to ONE governed
 * COUNT-of-violations `SELECT` that the route runs through the SAME governed query
 * path (`queryRun`) the profiler uses — AS THE OWNER — so the check reads exactly the
 * physical table the dataset materialized, and Trino's OPA plugin governs it. A count
 * of 0 violations is a PASS; anything > 0 is a FAIL. A rule that can't compile (no
 * column, unknown kind) or whose table isn't materialized is reported as "not run" —
 * NEVER a fake pass (the honesty contract).
 *
 * Pure module: string-in / value-in → SQL-string / verdict out, no engine, no network,
 * so the compilation + aggregation is trivially unit-tested (mirrors profile.ts).
 *
 * NOTE: dbt-core test integration is the future path (real `dbt test` runs). This is
 * the governed-SQL bridge that makes the recorded rules actually execute today.
 */

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export class DqError extends Error {}

/** A numeric literal, safe for SQL — non-finite is rejected (defence-in-depth). */
function num(n: number): string {
  if (!Number.isFinite(n)) throw new DqError('range bound must be a finite number');
  return String(n);
}

export type CompiledCheck = {
  id: string;
  /** The COUNT-of-violations SQL (single SELECT, no trailing semicolon). */
  sql: string;
};

/**
 * Compile ONE structured check to a violations-count SQL against `fqn`. Every branch
 * returns `select count(*) as v from <fqn> where <rows that VIOLATE the rule>`, so the
 * route reads back a single integer: 0 ⇒ pass, > 0 ⇒ fail. Throws {@link DqError} for
 * a rule that isn't executable (no `rule`, missing column/args) — the caller reports it
 * as "not run" rather than inventing a result.
 */
export function compileCheck(check: DataCheck, fqn: string): CompiledCheck {
  if (!check.rule) throw new DqError('this check is a free-text intention, not an executable rule');
  const col = (check.column ?? '').trim();
  if (!col) throw new DqError(`${check.rule} needs a column`);
  const c = quoteIdent(col);
  const from = `from ${fqn}`;

  let where: string;
  switch (check.rule) {
    case 'not_null':
      where = `${c} is null`;
      break;
    case 'not_blank':
      // A violation is NULL or an empty / whitespace-only string.
      where = `${c} is null or trim(cast(${c} as varchar)) = ''`;
      break;
    case 'unique': {
      // Rows whose value repeats: count total rows in duplicate groups (non-null).
      return {
        id: check.id,
        sql:
          `select coalesce(sum(cnt), 0) as v from ` +
          `(select ${c} as k, count(*) as cnt ${from} where ${c} is not null group by ${c} having count(*) > 1) t`,
      };
    }
    case 'accepted_values': {
      const vals = (check.values ?? []).map((v) => String(v).trim()).filter((v) => v.length > 0);
      if (vals.length === 0) throw new DqError('accepted_values needs at least one allowed value');
      const list = vals.map((v) => quoteLit(v)).join(', ');
      // A non-null value NOT in the accepted set is a violation.
      where = `${c} is not null and cast(${c} as varchar) not in (${list})`;
      break;
    }
    case 'range': {
      const hasMin = typeof check.min === 'number';
      const hasMax = typeof check.max === 'number';
      if (!hasMin && !hasMax) throw new DqError('range needs a min and/or a max');
      const parts: string[] = [];
      if (hasMin) parts.push(`${c} < ${num(check.min!)}`);
      if (hasMax) parts.push(`${c} > ${num(check.max!)}`);
      // A non-null value outside [min, max] is a violation.
      where = `${c} is not null and (${parts.join(' or ')})`;
      break;
    }
    default:
      throw new DqError(`unknown rule '${(check as { rule?: string }).rule}'`);
  }
  return { id: check.id, sql: `select count(*) as v ${from} where ${where}` };
}

/** A human label for a rule (used by the editor + reports + MCP). */
export function ruleLabel(check: DataCheck): string {
  const col = check.column ?? '';
  switch (check.rule) {
    case 'not_null':
      return `not_null(${col})`;
    case 'not_blank':
      return `not_blank(${col})`;
    case 'unique':
      return `unique(${col})`;
    case 'accepted_values':
      return `accepted_values(${col}, [${(check.values ?? []).join(', ')}])`;
    case 'range': {
      const lo = typeof check.min === 'number' ? check.min : '';
      const hi = typeof check.max === 'number' ? check.max : '';
      return `range(${col}, ${lo}, ${hi})`;
    }
    default:
      return check.name || 'check';
  }
}

export type CheckStatus = 'pass' | 'fail' | 'not_run';

export type CheckResult = {
  id: string;
  label: string;
  status: CheckStatus;
  /** Violation count for pass/fail; null when not run. */
  violations: number | null;
  /** Why it didn't run (compile error / not materialized), when status is not_run. */
  reason?: string;
};

/** A pass/fail from a violations count: 0 ⇒ pass, > 0 ⇒ fail. */
export function verdictFromViolations(violations: number): CheckStatus {
  return violations > 0 ? 'fail' : 'pass';
}

export type QualityBadge = 'passing' | 'failing' | 'unknown';

/**
 * Aggregate per-rule results into ONE honest badge:
 *   - any FAIL            ⇒ 'failing'
 *   - at least one PASS, no fails ⇒ 'passing'
 *   - nothing actually ran ⇒ 'unknown' (never a fake pass)
 */
export function aggregateBadge(results: CheckResult[]): QualityBadge {
  if (results.some((r) => r.status === 'fail')) return 'failing';
  if (results.some((r) => r.status === 'pass')) return 'passing';
  return 'unknown';
}
