/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * ask-chart — the PURE, HONEST "is this Talk-to-Data result chartable, and how?" core.
 *
 * Talk-to-Data returns an {@link AskGrid}-shaped result: `columns: string[]` and
 * `rows: string[][]` (every cell a STRING, because Bronze stays raw and Trino hands
 * back text). This module decides, WITHOUT touching a store or the network, whether
 * those exact rows have a clean chart shape — and if so, which column is the dimension,
 * which are the numeric measures, the default chart type, and the toggle types offered.
 *
 * HONESTY is the whole point:
 *   • A column is numeric ONLY if (nearly) all its non-empty cells parse as finite
 *     numbers. One non-numeric cell ⇒ the column is categorical. We NEVER coerce a
 *     stray string to 0 to "make it a measure".
 *   • Blank / non-parsing cells are skipped, never zero-filled — a gap is a gap.
 *   • The chart plots ONLY the returned rows. The SQL already did any aggregation; we
 *     do not re-aggregate, interpolate, or invent points.
 *   • If the plotted rows are a capped subset of the result, the hint carries the
 *     honest counts so the UI can say "first N of M rows" — never implying the whole
 *     result is shown.
 *
 * Kept free of `server-only` / Next imports so the SAME hint can be computed server-side
 * (attached to the grounding) AND the types imported by the `'use client'` chart leaf.
 */

/** The chart shapes the Talk-to-Data answer can render. `table` is always allowed. */
export type ChartType = 'bar' | 'line' | 'pie' | 'table';

/**
 * The pure chart plan for a chartable grid. `dimension` is the column INDEX of the
 * category/time axis; `measures` are the numeric column INDICES plotted as series. The
 * leaf reads `columns`/`rows` by these indices so it stays a thin view over the real
 * grid — nothing is pre-shaped or copied here.
 */
export type ChartHint = {
  /** Column index used as the x-axis / slice label (a date-like or categorical column). */
  dimension: number;
  /** Column indices parsed as honest numeric measures (≥1). */
  measures: number[];
  /** The chart shown by default when the answer first renders. */
  defaultType: ChartType;
  /** The types offered in the toggle (always includes `table`; `pie` only when apt). */
  allowedTypes: ChartType[];
  /** How many rows are actually plotted (≤ total). */
  plottedRows: number;
  /** How many rows the result held in full — `plottedRows < totalRows` ⇒ truncated. */
  totalRows: number;
};

/** Hard cap on plotted rows: a chart with more points than this is noise, not insight —
 *  and the honest caption tells the user it's the first N of the full result. */
export const MAX_CHART_ROWS = 100;

/** A categorical dimension with more distinct categories than this is too crowded for a
 *  pie (a bar is still fine). */
const MAX_PIE_CATEGORIES = 12;

/** A single non-empty cell parses as a finite number? (Honest: no coercion of words.) */
export function isNumericCell(cell: string): boolean {
  const s = (cell ?? '').trim();
  if (s === '') return false; // blank is "no value", not zero
  const n = Number(s);
  return Number.isFinite(n);
}

/** Parse a cell to a finite number, or `null` when it is blank / non-numeric.
 *  The chart skips `null`s (a gap), it never plots them as 0. */
export function parseNumber(cell: string): number | null {
  const s = (cell ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is the column at `col` an HONEST numeric measure? True only when the column has at
 * least one non-empty cell AND every non-empty cell parses as a finite number. A single
 * non-numeric non-empty cell ⇒ false (treat the whole column as categorical) — we never
 * guess a value to keep a column "numeric".
 */
export function isNumericColumn(rows: string[][], col: number): boolean {
  let nonEmpty = 0;
  for (const r of rows) {
    const cell = r[col] ?? '';
    if (cell.trim() === '') continue;
    nonEmpty += 1;
    if (!isNumericCell(cell)) return false;
  }
  return nonEmpty > 0;
}

/** ISO-ish date / datetime / year-month, or a bare 4-digit year — the shapes Trino
 *  hands back for date/timestamp columns. Deliberately strict: a random string that
 *  merely contains digits is NOT date-like. */
const DATE_LIKE = /^\d{4}(-\d{2}(-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?)?)?$/;

/** Is the column at `col` date/time-like across its non-empty cells? Used only to pick a
 *  LINE default over a BAR default — it never changes what is plotted. */
export function isDateLikeColumn(rows: string[][], col: number): boolean {
  let nonEmpty = 0;
  for (const r of rows) {
    const cell = (r[col] ?? '').trim();
    if (cell === '') continue;
    nonEmpty += 1;
    if (!DATE_LIKE.test(cell)) return false;
  }
  return nonEmpty > 0;
}

/** Count distinct values in a column across the plotted rows (for the pie-cardinality gate). */
function distinctCount(rows: string[][], col: number): number {
  const seen = new Set<string>();
  for (const r of rows) seen.add((r[col] ?? '').trim());
  return seen.size;
}

/**
 * Decide whether the grid is chartable and, if so, the plan. Returns `null` (⇒ table
 * only) when the shape is not clean: fewer than 2 rows, only one column, no numeric
 * column, no non-numeric dimension, or too many categories for even a bar.
 *
 * The plan plots ONLY the first {@link MAX_CHART_ROWS} rows in the order the SQL returned
 * them (the same real, governed rows the text answer is grounded in) and records the full
 * count so the caller can label truncation honestly.
 */
export function deriveChart(columns: string[], rows: string[][]): ChartHint | null {
  const totalRows = rows.length;
  if (columns.length < 2 || totalRows < 2) return null;

  const plotted = rows.slice(0, MAX_CHART_ROWS);

  // Classify every column over the PLOTTED rows.
  const numericCols: number[] = [];
  const categoricalCols: number[] = [];
  for (let c = 0; c < columns.length; c += 1) {
    if (isNumericColumn(plotted, c)) numericCols.push(c);
    else categoricalCols.push(c);
  }
  if (numericCols.length === 0) return null; // nothing to measure ⇒ table only

  // The dimension is the FIRST column that isn't a numeric measure. If every column is
  // numeric (e.g. a pure numbers table), there is no clean category axis ⇒ table only.
  const dimension = categoricalCols[0];
  if (dimension === undefined) return null;

  const measures = numericCols;
  const dateLike = isDateLikeColumn(plotted, dimension);
  const singleMeasure = measures.length === 1;
  const categories = distinctCount(plotted, dimension);

  // Too many categories for any bar/pie to be legible ⇒ table only (never a forced,
  // unreadable chart). A time series is exempt — a dense line is still meaningful.
  if (!dateLike && categories > MAX_CHART_ROWS) return null;

  // A date/time dimension → line by default; a categorical dimension → bar by default
  // (grouped when multi-measure).
  const defaultType: ChartType = dateLike ? 'line' : 'bar';
  const allowed: ChartType[] = ['bar', 'line'];
  // Pie is offered ONLY for a single-measure, low-cardinality categorical breakdown —
  // it can't show a time series or multiple measures honestly.
  if (!dateLike && singleMeasure && categories <= MAX_PIE_CATEGORIES) allowed.push('pie');
  allowed.push('table'); // the table is always available

  return {
    dimension,
    measures,
    defaultType,
    allowedTypes: allowed,
    plottedRows: plotted.length,
    totalRows,
  };
}
