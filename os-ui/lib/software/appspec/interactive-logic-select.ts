/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE turn-a-grid-into-options helper for the 3.5c interactive patterns. A `QueryResult`
 * (`{ columns, rows }`) + a label field name becomes a list of `{ value, label }` options where:
 *   • `value` is a STABLE per-row key — the first column whose name looks like an id (`id`, or
 *     `*_id`, case-insensitive), else the first column, else the row index. This is what an
 *     assignment/decision/completion record stores as its `itemId`/`assigneeId`/`taskId`, so it
 *     must be stable across reloads (an index-only fallback is the honest last resort).
 *   • `label` is the value in the configured label column (falls back to the value itself).
 * DOM-free + unit-tested; the renderers only present these.
 */
import type { QueryResult } from '@/lib/app-sdk/index.ts';

export type SelectOption = { value: string; label: string };
export type SelectOptions = { options: SelectOption[]; error?: string };

/** Column names that qualify as a stable key: exactly `id` or ending in `_id` (case-insensitive). */
function isKeyColumn(name: string): boolean {
  return /^id$/i.test(name) || /_id$/i.test(name);
}

/** The index of the stable key column: an id-like column, else column 0 (−1 if no columns). */
export function keyColumnIndex(columns: string[]): number {
  const k = columns.findIndex(isKeyColumn);
  if (k >= 0) return k;
  return columns.length > 0 ? 0 : -1;
}

/**
 * Build the `{ value, label }` options for a picker. Returns a typed `error` (not a throw) when the
 * configured label field is not a column — the renderer surfaces it as an honest Alert. An empty /
 * missing result yields no options (no fabricated rows).
 */
export function pickOptions(result: QueryResult | undefined, labelField: string): SelectOptions {
  if (!result) return { options: [] };
  const { columns, rows } = result;
  const labelIdx = columns.indexOf(labelField);
  if (labelIdx < 0 && rows.length > 0) {
    return { options: [], error: `Field “${labelField}” is not in this dataset (columns: ${columns.join(', ')}).` };
  }
  const keyIdx = keyColumnIndex(columns);
  const options = rows.map((row, i) => {
    const value = keyIdx >= 0 ? (row[keyIdx] ?? String(i)) : String(i);
    const label = labelIdx >= 0 ? (row[labelIdx] ?? '') : '';
    return { value: value === '' ? String(i) : value, label: label === '' ? value || String(i) : label };
  });
  return { options };
}

/**
 * Build `{ id, title, subtitle }` rows for the approval-queue / task-checklist when the source is a
 * dataset. `id` is the stable key (as above), `title` the title column's value, `subtitle` the
 * joined subtitle columns. Returns a typed `error` when `titleField` is not a column.
 */
export type SourceRow = { id: string; title: string; subtitle: string };
export type SourceRows = { rows: SourceRow[]; error?: string };

/**
 * Turn the app's own records (open bags) into a `QueryResult` grid so the same `pickSourceRows`
 * path serves BOTH a granted dataset and the app's own `records` source. Columns are the union of
 * the records' keys (first-seen order); cells are stringified (null/undefined → '').
 */
export function recordsToGrid(records: Record<string, unknown>[]): QueryResult {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  const rows = records.map((r) => columns.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))));
  return { columns, rows, rowCount: rows.length };
}

export function pickSourceRows(
  result: QueryResult | undefined,
  titleField: string,
  subtitleFields: string[] = [],
): SourceRows {
  if (!result) return { rows: [] };
  const { columns, rows } = result;
  const titleIdx = columns.indexOf(titleField);
  if (titleIdx < 0 && rows.length > 0) {
    return { rows: [], error: `Field “${titleField}” is not in this dataset (columns: ${columns.join(', ')}).` };
  }
  const keyIdx = keyColumnIndex(columns);
  const subIdxs = subtitleFields.map((f) => columns.indexOf(f)).filter((i) => i >= 0);
  const out = rows.map((row, i) => {
    const id = keyIdx >= 0 ? (row[keyIdx] ?? String(i)) : String(i);
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '') : '';
    const subtitle = subIdxs.map((si) => row[si] ?? '').filter((v) => v !== '').join(' · ');
    return { id: id === '' ? String(i) : id, title: title === '' ? '—' : title, subtitle };
  });
  return { rows: out };
}
