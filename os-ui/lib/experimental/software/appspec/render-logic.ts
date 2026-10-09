/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AppSpec render logic — the PURE, client-safe core the Phase-2 `<AppSpecRenderer>` and the
 * unit tests share. NO React, NO DOM, NO `server-only`: total functions over the string
 * grid a governed `QueryResult` returns (`columns: string[]`, `rows: string[][]`), so the
 * renderer inherits correct column-mapping / formatting / filter / search / sort / paginate
 * behaviour that is tested here once, thoroughly.
 */

import type { Control, Format, TableColumn } from './schema.ts';

/** A spec column resolved against the LIVE result columns: its formatting metadata plus the
 *  index of its data in each row BY NAME (`-1` when the live result lacks it → render '—'). */
export type ResolvedColumn = {
  field: string;
  label: string;
  format: Format;
  index: number;
};

/**
 * Map each spec column to its position in the live `QueryResult.columns` BY NAME. The live
 * result may reorder or omit columns; matching by name (not position) is what makes the
 * renderer robust to schema drift. A missing column resolves to `index: -1` so the renderer
 * can show a placeholder instead of crashing or shifting other columns.
 */
export function resolveColumns(queryResultColumns: string[], specColumns: TableColumn[]): ResolvedColumn[] {
  return specColumns.map((c) => ({
    field: c.field,
    label: c.label ?? c.field,
    format: c.format ?? 'text',
    index: queryResultColumns.indexOf(c.field),
  }));
}

/** Stable, locale-independent EUR formatter (fixed 'de-DE' so tests + server + client agree). */
const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
/** Stable grouped-number formatter (same fixed locale). */
const NUM = new Intl.NumberFormat('de-DE');

/**
 * Format ONE cell value (always a string off the grid) per its column format. Pure and
 * locale-stable. Non-numeric input to a numeric format, or unparseable date, falls back to
 * the raw string (never throws, never 'NaN'). 'badge' returns the raw value — the renderer
 * decides the chrome; this keeps the function DOM-free.
 */
export function formatCell(value: string, format: Format): string {
  switch (format) {
    case 'number': {
      const n = Number(value);
      return value.trim() !== '' && Number.isFinite(n) ? NUM.format(n) : value;
    }
    case 'currency-eur': {
      const n = Number(value);
      return value.trim() !== '' && Number.isFinite(n) ? EUR.format(n) : value;
    }
    case 'date': {
      const t = Date.parse(value);
      if (Number.isNaN(t)) return value;
      // ISO date (yyyy-mm-dd) — locale-stable, deterministic across environments.
      return new Date(t).toISOString().slice(0, 10);
    }
    case 'text':
    case 'badge':
    default:
      return value;
  }
}

/** Numeric formats sort numerically; everything else lexically. */
function isNumericFormat(format: Format): boolean {
  return format === 'number' || format === 'currency-eur';
}

export type ViewState = {
  /** Free-text search across every resolved column (case-insensitive substring). */
  search?: string;
  /** Per-field exact/substring/range filters, keyed by spec field name. */
  filters?: Record<string, FilterValue>;
  /** Sort by a spec field name, with direction. */
  sort?: { field: string; dir: 'asc' | 'desc' };
  /** 0-based page index. */
  page?: number;
  /** Rows per page (defaults to the full set when absent/≤0). */
  pageSize?: number;
};

/** A filter value: a `select` picks an exact value, `search` a substring, `range` a min/max. */
export type FilterValue =
  | { control: 'select'; value: string }
  | { control: 'search'; value: string }
  | { control: 'range'; min?: number; max?: number };

/**
 * Apply search → filter → sort → paginate over the string grid, generically. Returns the
 * page of rows plus the TOTAL matching row count (before pagination) so the renderer can
 * show "X of N". Pure: never mutates `rows`.
 */
export function applyView(
  rows: string[][],
  resolved: ResolvedColumn[],
  state: ViewState,
): { rows: string[][]; total: number } {
  const byField = new Map(resolved.map((c) => [c.field, c]));

  // Rows carrying an out-of-range/absent column index read as '' for that column.
  const cell = (row: string[], col: ResolvedColumn): string => (col.index >= 0 ? row[col.index] ?? '' : '');

  let out = rows;

  // 1. free-text search across all resolved columns.
  const q = state.search?.trim().toLowerCase();
  if (q) {
    out = out.filter((row) => resolved.some((col) => cell(row, col).toLowerCase().includes(q)));
  }

  // 2. per-field filters.
  if (state.filters) {
    for (const [field, fv] of Object.entries(state.filters)) {
      const col = byField.get(field);
      if (!col) continue; // filter on an unmapped field ⇒ no-op (fail-soft)
      out = out.filter((row) => matchesFilter(cell(row, col), fv));
    }
  }

  const total = out.length;

  // 3. sort (numeric-aware for numeric formats).
  if (state.sort) {
    const col = byField.get(state.sort.field);
    if (col) {
      const dir = state.sort.dir === 'desc' ? -1 : 1;
      const numeric = isNumericFormat(col.format);
      out = [...out].sort((a, b) => {
        const av = cell(a, col);
        const bv = cell(b, col);
        if (numeric) {
          const an = Number(av);
          const bn = Number(bv);
          const aok = av.trim() !== '' && Number.isFinite(an);
          const bok = bv.trim() !== '' && Number.isFinite(bn);
          // Non-numeric/blank values sort last, stably.
          if (!aok && !bok) return 0;
          if (!aok) return 1;
          if (!bok) return -1;
          return (an - bn) * dir;
        }
        return av.localeCompare(bv) * dir;
      });
    }
  }

  // 4. paginate.
  const size = state.pageSize && state.pageSize > 0 ? state.pageSize : total;
  const page = state.page && state.page > 0 ? state.page : 0;
  const start = page * size;
  const pageRows = size >= total && page === 0 ? out : out.slice(start, start + size);

  return { rows: pageRows, total };
}

/** Does a raw cell string match one filter value? Pure; range parses numerically. */
function matchesFilter(raw: string, fv: FilterValue): boolean {
  switch (fv.control) {
    case 'select':
      return fv.value === '' ? true : raw === fv.value;
    case 'search':
      return fv.value.trim() === '' ? true : raw.toLowerCase().includes(fv.value.trim().toLowerCase());
    case 'range': {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) return false;
      // Guard an INVERTED range: if the author (or a bad spec) supplies min>max, treat it as
      // the same inclusive band [min(a,b), max(a,b)] rather than silently matching nothing.
      // min==max is a valid exact-match band; both bounds may be absent (open range).
      const lo = fv.min !== undefined && fv.max !== undefined ? Math.min(fv.min, fv.max) : fv.min;
      const hi = fv.min !== undefined && fv.max !== undefined ? Math.max(fv.min, fv.max) : fv.max;
      if (lo !== undefined && n < lo) return false;
      if (hi !== undefined && n > hi) return false;
      return true;
    }
    default:
      return true;
  }
}

/** Re-exported for callers that build filter UIs from the control enum. */
export type { Control };
