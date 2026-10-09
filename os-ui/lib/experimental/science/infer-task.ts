/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * PURE, dtype- AND content-aware ML task inference from a target column. No `server-only`, no
 * network — string/number in, task out — so it's trivially `node --test`-safe and importable by
 * the grounding layer.
 *
 * WHY this exists: the Design assistant proposes a `taskType`, and in the SIMPLE user flow there
 * is NO task selector at all — so a wrong guess (e.g. binary_classification on a continuous
 * `duration_days` double) silently aborts training ("InferenceService not found"). The OS must
 * infer the task correctly, automatically, from the target column ITSELF.
 *
 * HEURISTIC — CONTENT FIRST, declared type only a tiebreaker. Bronze stays raw (a numeric column
 * can be typed varchar, a yes/no can be a 0/1 bigint), so the ACTUAL VALUES decide when we have
 * them; the declared Trino type is a secondary hint used only when the content profile is missing
 * or ambiguous. Precedence (first match wins):
 *
 *   1. distinctCount === 2                       → binary_classification   (0/1, true/false, Y/N — any type)
 *   2. boolean type                              → binary_classification
 *   3. numeric with a fractional value present   → regression             (a real number ⇒ continuous; the duration_days case)
 *   4. small distinct set (≤ CATEGORICAL_MAX) AND (string OR integer-valued numeric)
 *                                                → multiclass_classification (low-cardinality categories)
 *   5. numeric (many-distinct / unknown-distinct / non-integer) → regression
 *   6. high-cardinality string (distinct > STRING_CATEGORICAL_MAX, or unknown) → undefined
 *                                                (likely an id — a poor target; let the caller warn, don't force)
 *   7. date/timestamp/other, no content signal   → undefined
 *
 * `undefined` means "we can't say" — the caller keeps whatever the assistant proposed (and may warn).
 */

/** The content profile of a target column (all optional — content wins when present). */
export type TargetProfile = {
  /** Declared Trino type (e.g. `double`, `bigint`, `varchar(20)`, `boolean`). Secondary hint. */
  type: string;
  /** count(distinct target). The strongest signal when known. */
  distinctCount?: number;
  /** For numeric targets: are ALL non-null values whole numbers? (false ⇒ fractional ⇒ continuous). */
  isIntegerValued?: boolean;
  /** count(non-null target) — reserved for future use / diagnostics. */
  nonNull?: number;
  /** count(*) — reserved for future use / diagnostics. */
  rowCount?: number;
};

export type InferredTask = 'binary_classification' | 'multiclass_classification' | 'regression' | undefined;

/** A small integer/string distinct set reads as categories, not a continuum. */
const CATEGORICAL_MAX = 15;
/** A string with more distinct values than this is treated as high-cardinality (≈ an id). */
const STRING_CATEGORICAL_MAX = 20;

/** Normalize a Trino type to a bare lower-case base name (`decimal(10,2)` → `decimal`). */
function baseType(trinoType: string): string {
  return (trinoType || '').trim().toLowerCase().replace(/\(.*$/, '').trim();
}

const FLOATING = new Set(['double', 'real', 'float', 'decimal', 'numeric']);
const INTEGER = new Set(['tinyint', 'smallint', 'integer', 'int', 'bigint']);
const STRING = new Set(['varchar', 'char', 'string', 'text']);

/**
 * Infer the ML task from a target column's CONTENT profile (falling back to its declared type).
 * See the module doc for the full precedence. Returns `undefined` when we genuinely can't say.
 */
export function inferTaskFromTarget(profile: TargetProfile): InferredTask {
  const type = baseType(profile.type);
  const distinct = profile.distinctCount;
  const isFloat = FLOATING.has(type);
  const isInt = INTEGER.has(type);
  const isString = STRING.has(type);
  const isNumeric = isFloat || isInt;

  // 1. Exactly two distinct values is binary, whatever the declared type (0/1, true/false, Y/N).
  if (distinct === 2) return 'binary_classification';

  // 2. A boolean column is binary by definition.
  if (type === 'boolean') return 'binary_classification';

  // 3. A numeric column with an observed fractional value is continuous → regression.
  //    (isIntegerValued === false means the profile SAW a non-whole number.)
  if (isNumeric && profile.isIntegerValued === false) return 'regression';

  // 4. A small distinct set of strings, or of integer-valued numbers, reads as categories.
  const isIntegerLike = isString || (isNumeric && profile.isIntegerValued !== false);
  if (typeof distinct === 'number' && distinct <= CATEGORICAL_MAX && isIntegerLike) {
    return 'multiclass_classification';
  }

  // 5. Any other numeric target (many-distinct / unknown-distinct / non-integer) → regression.
  if (isNumeric) return 'regression';

  // 6. A string target we couldn't call categorical: high-cardinality ⇒ likely an id ⇒ can't say.
  if (isString) {
    if (typeof distinct === 'number' && distinct <= STRING_CATEGORICAL_MAX) return 'multiclass_classification';
    return undefined; // unknown distinct OR high-cardinality — let the caller warn, don't force.
  }

  // 7. date/timestamp/other with no content signal — we can't infer a task honestly.
  return undefined;
}
