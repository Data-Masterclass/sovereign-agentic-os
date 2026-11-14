/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS's one chart formatter module — numbers, member labels and CSV of rendered rows
 * USER STORY: As a user I want 1 234 567 to read as "1.2M" in the same way on a dashboard panel, in
 *             a query result and inside an app's chart, and a CSV export to be exactly the rows I
 *             can see (D-R1.1, D-R5.8 groundwork).
 * ARCHITECTURE:
 *   - PURE and dependency-free, so it is unit tested directly and is safe in a server module.
 *   - Deliberately NOT the vendored Superset `number-format`/`time-format` catalogue yet (plan D8
 *     slice 2): that is a catalogue plus a grammar evaluator, and shipping half of it would give
 *     two formatters. This is the OS's current behaviour, consolidated into one place first.
 *   - {@link toCsv} serialises the rows a surface ALREADY rendered (the governed, RLS-scoped
 *     result). It never recomputes or re-requests anything — a CSV that disagrees with the chart
 *     above it would be exactly the dishonesty the loud-degradation contract exists to prevent.
 */

/** The leaf of a governed member (`Sales.revenue` → `revenue`) for calm axis and legend text. */
export function leaf(member: string): string {
  const i = member.lastIndexOf('.');
  return i >= 0 ? member.slice(i + 1) : member;
}

/** A finite number, or 0 — chart data may never be `NaN` (ECharts renders it as a gap silently). */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A calm, compact number for KPIs and axis labels (1.2M / 34.5k / 812 / — for non-finite). */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** A filesystem-safe slug for a download name (`Sales Overview` → `sales-overview`). */
export function fileSlug(name: string, fallback: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

/**
 * RFC-4180-ish CSV of the rows a surface rendered: leaf-named headers, fields quoted and escaped
 * when they contain a comma, quote or newline. Column order is the caller's, verbatim.
 */
export function toCsv(cols: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.map((c) => esc(leaf(c))).join(','),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(',')),
  ].join('\n');
}
