/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    `panelChartSpec(panel, rows)` — a governed panel as the OS's shared chart spec
 * USER STORY: As a user I want a dashboard panel and the same numbers shown anywhere else in the OS
 *             to draw the identical chart, so I never have to wonder which one is right (D-R1.2).
 * ARCHITECTURE:
 *   - PURE, and the ONLY place a `Panel` is mapped onto `@core/ui/charts`'s `ChartSpec`. It was
 *     inline in `ui/PanelChart.tsx`, where a test could not reach it; the component is now a shell
 *     over this plus `buildChartOption`.
 *   - Reaches `core/ui/charts/spec.ts` `fromRows` — the one row→spec adapter — so this host and any
 *     other host that maps its own model the same way cannot produce different options.
 *   - KPI (`big_number`/`big_number_total`) and `table` are NOT charts: they are HTML surfaces, so
 *     this returns `null` for them and the component renders its own.
 *   - Never resolves, re-aggregates or re-requests anything: `rows` are what `runPanelQuery`
 *     already returned under the viewer's identity, and the loud-degradation warning that came
 *     with them is the component's to show.
 */
import { fromRows, type ChartSpec } from '@core/ui/charts/spec';
import { type Panel, panelMetrics } from '@tabs/dashboards/lib/model';

/** The viz types that draw as an ECharts chart (the rest are HTML surfaces). */
const CHART_VIZ = new Set(['line', 'area', 'bar', 'pie']);

/** Is this panel drawn as a chart (rather than a KPI number or a table)? */
export function isChartPanel(panel: Panel): boolean {
  return CHART_VIZ.has(panel.vizType);
}

/**
 * The first key on the rows that is not one of the panel's measures — the dimension the governed
 * query grouped by. Returns `undefined` for a single-aggregate result (one unlabelled bar).
 */
export function dimensionOf(rows: Record<string, unknown>[], measures: string[]): string | undefined {
  const first = rows[0] ?? {};
  return Object.keys(first).find((k) => !measures.includes(k));
}

/**
 * A panel + its governed rows as the shared chart spec, or `null` when there is nothing to chart
 * (a KPI, a table, no measures, or a pie with no dimension to slice by).
 */
export function panelChartSpec(panel: Panel, rows: Record<string, unknown>[], height?: number): ChartSpec | null {
  if (!isChartPanel(panel)) return null;
  const measures = panelMetrics(panel);
  if (measures.length === 0) return null;

  if (panel.vizType === 'pie') {
    // A pie needs a category to slice by and exactly one measure to size the slices.
    const dim = dimensionOf(rows, measures);
    if (!dim) return null;
    return fromRows({ kind: 'pie', rows, categoryKey: dim, valueKeys: [measures[0]], height });
  }

  // line / area trend over the panel's time dimension; bar groups by its first dimension. Either
  // way, if the governed result carries a different key than the panel asked for we chart what the
  // ROWS actually have — the honest warning about the mismatch travels with the result.
  const preferred = panel.vizType === 'bar' ? undefined : panel.timeDimension;
  const categoryKey = preferred && rows.some((r) => preferred in r) ? preferred : dimensionOf(rows, measures);
  return fromRows({
    kind: panel.vizType === 'area' ? 'area' : panel.vizType === 'bar' ? 'bar' : 'line',
    rows,
    categoryKey,
    valueKeys: measures,
    temporal: Boolean(panel.timeDimension) && categoryKey === panel.timeDimension,
    height,
  });
}
