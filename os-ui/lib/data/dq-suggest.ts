/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { DataCheck, DataCheckRule } from './dataset-schema.ts';
import type { ColumnProfile, Profile } from './profile.ts';

/**
 * Deterministic profile → data-quality-rule suggestions (Data tab · Validate stage,
 * Phase 0 of the data-quality plan).
 *
 * This is the honest, rules-first half of "suggest checks from the profile": a pure
 * function that reads the ONE-scan profile (`lib/data/profile.ts` — null-count,
 * approx-distinct, min/max, top categories) and proposes the OBVIOUS structured rules,
 * each carrying the exact profile EVIDENCE that justifies it:
 *
 *   - 0 nulls over a non-empty table            ⇒ not_null(col)      ("0 nulls in N rows")
 *   - ~100% distinct over a non-empty table     ⇒ unique(col)        ("N of N distinct")
 *   - a small closed category set (string)      ⇒ accepted_values    ("k categories seen")
 *   - a numeric column with observed min/max    ⇒ range(col,min,max) ("observed 0–1000")
 *
 * It NEVER writes and NEVER invents data — every suggestion is grounded in a profile
 * statistic. The Validate assistant is a *separate, optional* layer that fills in prose
 * descriptions/rationale; this module works with no model at all (deterministic first).
 * Suggestions that duplicate a rule the dataset already has are dropped, so "Accept all"
 * is idempotent.
 */

export type SuggestedCheck = {
  rule: DataCheckRule;
  column: string;
  /** accepted_values only. */
  values?: string[];
  /** range only. */
  min?: number;
  max?: number;
  /** One plain sentence citing the profile statistic that justifies the rule. */
  evidence: string;
};

// A category set counts as "closed" only when it's small AND approx_distinct agrees the
// column is low-cardinality — so a free-text column with a handful of sampled top values
// is NOT mistaken for an enum.
const MAX_CATEGORY_SET = 12;
// approx_distinct is approximate; allow a small slack before calling a column "unique".
const UNIQUE_SLACK = 0.999;

/** A stable key so a suggestion and an existing rule on the same column/kind dedupe. */
function checkKey(rule: DataCheckRule, column: string): string {
  return `${rule}:${column}`;
}

function existingKeys(existing: DataCheck[]): Set<string> {
  const keys = new Set<string>();
  for (const c of existing) {
    if (c.rule && c.column) keys.add(checkKey(c.rule, c.column));
  }
  return keys;
}

/** Parse a numeric min/max the profiler returned as a varchar. Non-numeric ⇒ null. */
function asFinite(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The obvious rules for ONE column, given the whole-table row count. */
function suggestForColumn(col: ColumnProfile, rowCount: number): SuggestedCheck[] {
  const out: SuggestedCheck[] = [];
  if (rowCount <= 0) return out; // an empty table proves nothing.

  // 0 nulls ⇒ the column is (observed) complete ⇒ assert not_null.
  if (col.nulls === 0) {
    out.push({ rule: 'not_null', column: col.name, evidence: `0 nulls in ${rowCount} rows` });
  }

  // ~100% distinct (and not a boolean/near-constant) ⇒ assert unique.
  // Guard rowCount > 1 so a single-row table doesn't read as "unique".
  if (rowCount > 1 && col.kind !== 'boolean' && col.distinct >= Math.floor(rowCount * UNIQUE_SLACK)) {
    out.push({ rule: 'unique', column: col.name, evidence: `${col.distinct} of ${rowCount} distinct` });
  }

  // A small closed category set on a string/boolean column ⇒ accepted_values.
  // Use the top-values the profiler already fetched as the observed set; only when the
  // approx-distinct count agrees the whole column fits inside that set (no long tail).
  if (
    (col.kind === 'string' || col.kind === 'boolean') &&
    col.distinct > 0 &&
    col.distinct <= MAX_CATEGORY_SET &&
    col.top.length > 0 &&
    col.top.length >= col.distinct
  ) {
    const values = col.top.map((t) => t.value).filter((v) => v !== '∅');
    if (values.length > 0) {
      out.push({
        rule: 'accepted_values',
        column: col.name,
        values,
        evidence: `${values.length} categor${values.length === 1 ? 'y' : 'ies'} seen: ${values.join(', ')}`,
      });
    }
  }

  // A numeric column with an observed min/max ⇒ range(min, max).
  if (col.kind === 'numeric') {
    const min = asFinite(col.min);
    const max = asFinite(col.max);
    if (min !== null && max !== null && min <= max) {
      out.push({ rule: 'range', column: col.name, min, max, evidence: `observed ${min}–${max}` });
    }
  }

  return out;
}

/**
 * The obvious rules across a profiled dataset, MINUS any the dataset already has. Pure:
 * profile-in / suggestions-out, no engine, no network, so the mapping is unit-tested.
 */
export function suggestChecks(profile: Profile, existing: DataCheck[] = []): SuggestedCheck[] {
  const have = existingKeys(existing);
  const out: SuggestedCheck[] = [];
  const seen = new Set<string>();
  for (const col of profile.columns) {
    for (const s of suggestForColumn(col, profile.rowCount)) {
      const key = checkKey(s.rule, s.column);
      if (have.has(key) || seen.has(key)) continue; // don't re-suggest an existing/dup rule.
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
