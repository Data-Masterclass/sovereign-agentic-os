/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Pure KPI helpers — the DOM-free core the `kpi-overview` cards + the `landing` KPI block share.
 * A KPI card's number is EITHER a governed metric scalar (the first cell of a metric query) or a
 * dataset AGGREGATE (count / sum / avg over a fetched dataset grid). Both reduce here to a single
 * number, so the number rendered is exactly what the governed result returned — never invented.
 */

import type { QueryResult } from '@/lib/app-sdk/index.ts';
import type { KpiAgg } from './patterns.ts';

/** Read the single scalar a metric query returns (its first cell), honestly. `null` when empty. */
export function metricScalar(result: QueryResult): number | null {
  const raw = result.rows?.[0]?.[0];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Aggregate a dataset grid to one number. `count` → row count (no field needed); `sum`/`avg` →
 * over the named field's numeric cells (non-numeric/blank cells are IGNORED, never coerced to 0,
 * so an average stays honest). Returns `null` when a sum/avg has no numeric cell to reduce.
 */
export function aggregateDataset(result: QueryResult, agg: KpiAgg, field?: string): number | null {
  const rows = result.rows ?? [];
  if (agg === 'count') return rows.length;
  if (!field) return null;
  const idx = result.columns.indexOf(field);
  if (idx < 0) return null;
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const raw = row[idx];
    if (raw === undefined || raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  if (n === 0) return null;
  return agg === 'sum' ? sum : sum / n;
}

/** A calm, compact headline number (1.2M / 34.5k / 812), locale-stable. `—` for null. */
export function formatKpi(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
