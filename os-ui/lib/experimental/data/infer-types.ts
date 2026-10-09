/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { CastType } from './transform.ts';

/**
 * Deterministic Silver TYPE AUTODETECT — infer each column's likely type from the
 * ACTUAL sampled Bronze rows (governed preview), never from the column name and never
 * from a model. Bronze is all-text by design (no silent coercion); this is the
 * approved-suggestion half of that contract: the Silver stage SHOWS what the data
 * looks like and the USER applies the cast. Rules are strict — every non-empty
 * sampled value must match, or no suggestion is made (a wrong suggestion is worse
 * than none). Pure + unit-tested; the panel calls it on the preview rows it already
 * has, so detection costs no extra query.
 */

const BOOL_TRUE = new Set(['true', 'yes', 'y', 't']);
const BOOL_FALSE = new Set(['false', 'no', 'n', 'f']);

const INT_RE = /^-?\d+$/;
const DOUBLE_RE = /^-?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/;

/** Infer one column's type from its sampled values, or null (stay text). */
export function inferType(values: string[]): CastType | null {
  const sample = values.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  if (sample.length === 0) return null;

  // Numbers FIRST: an all-0/1 column reads as integer, not boolean (less surprising,
  // and boolean stays available as a manual choice).
  if (sample.every((v) => INT_RE.test(v))) {
    // int32 range decides integer vs bigint (magnitude check, not digit count).
    return sample.every((v) => Math.abs(Number(v)) <= 2147483647) ? 'integer' : 'bigint';
  }
  if (sample.every((v) => DOUBLE_RE.test(v))) return 'double';
  if (sample.every((v) => DATE_RE.test(v))) return 'date';
  if (sample.every((v) => TIMESTAMP_RE.test(v))) return 'timestamp';
  const lower = sample.map((v) => v.toLowerCase());
  if (lower.every((v) => BOOL_TRUE.has(v) || BOOL_FALSE.has(v))) return 'boolean';
  return null;
}

export type TypeSuggestion = { column: string; type: CastType };

/** Suggestions for every column of a preview grid (columns + row-major string cells). */
export function inferColumnTypes(columns: string[], rows: string[][]): TypeSuggestion[] {
  const out: TypeSuggestion[] = [];
  columns.forEach((column, i) => {
    const type = inferType(rows.map((r) => r[i] ?? ''));
    if (type) out.push({ column, type });
  });
  return out;
}
