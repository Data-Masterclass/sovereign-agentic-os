/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One pure `ChartSpec → EChartsOption` builder for every host in the OS
 * USER STORY: As a developer I want the same chart spec, drawn in the Dashboards tab, in a query
 *             result or inside a vibe-engineered app, to produce the identical option object — so a
 *             line chart cannot be smooth in one tab and angular in another (D-R1.2, D1).
 * ARCHITECTURE:
 *   - PURE: rows + resolved colours in, option out. No DOM, no `echarts` import, no React — so it
 *     is unit tested directly and the identical-in-two-hosts claim is a measurement, not a hope.
 *   - The line/area/bar families are built by the VENDORED Apache Superset transformer
 *     (`os-ui/vendor/superset/echarts/timeseries.ts` — `transformTimeseries`, which itself uses
 *     upstream's `extractSeries` / `getAxisType` / `getChartPadding` / `getMinAndMaxFromBounds`).
 *     That is deliverable 3 of the dashboards stream: one vendored transformer, end to end, behind
 *     this surface. Pie stays an OS-local option — upstream's Pie transformer pulls in the label
 *     layout, `extractGroupbyLabel` and the Emotion tooltip, which is a second slice, not this one.
 *   - {@link fromRows} is the ONE row→spec adapter. Every host maps its own model onto it, so two
 *     hosts with the same rows and the same keys cannot drift: `tabs/dashboards/lib/chart-spec.ts`
 *     maps a `Panel`, and any other host maps its own shape the same way.
 *   - Deliberately NOT a renderer and NOT a registration: those are `Chart.tsx` and `register.ts`.
 */
import { leaf, num } from '@core/ui/charts/format';
import type { ChartColors } from '@core/ui/charts/theme';
import {
  EchartsTimeseriesSeriesType,
  GenericDataType,
  LegendType,
  LegendOrientation,
  type DataRecord,
} from '../../../vendor/superset/echarts/types';
import { transformTimeseries, type TimeseriesOption } from '../../../vendor/superset/echarts/timeseries';

/** The chart families this surface draws. A KPI and a table are HTML, not an ECharts option. */
export type ChartKind = 'line' | 'area' | 'bar' | 'pie';

/**
 * One series: its governed member name (used verbatim as the legend/series id) and its values.
 *
 * `null` is a GAP, not a zero (M-4). A blank or non-numeric cell must never be plotted as 0 — that
 * is a fabricated number, and the chart would read as "we sold nothing" rather than "we do not
 * know". Governed metric panels coerce to a number because an aggregate always has one; a raw
 * query result does not, and says so by passing `nullable`.
 */
export type ChartSeries = { name: string; values: (number | null)[] };

/**
 * A host-independent chart spec. Everything a chart needs and nothing a host owns: no title, no
 * height, no governance, no warning — those live in the host's shell.
 */
export type ChartSpec = {
  kind: ChartKind;
  /** The x-axis / slice categories, already stringified by the host. */
  categories: string[];
  series: ChartSeries[];
  /** True when the categories are a time dimension (drives a time axis, not a category axis). */
  temporal?: boolean;
  /** Chart height in px — the vendored transformer's responsive y-axis needs it. */
  height?: number;
};

/** An ECharts option as this surface produces it (structural; see `vendor/superset/echarts`). */
export type OsChartOption = TimeseriesOption | PieOption;

export type PieOption = {
  tooltip: Record<string, unknown>;
  legend: Record<string, unknown>;
  color: string[];
  series: Record<string, unknown>[];
};

export type FromRowsInput = {
  kind: ChartKind;
  rows: Record<string, unknown>[];
  /** The column holding the category / time value. */
  categoryKey?: string;
  /** The measure columns, in series order. */
  valueKeys: string[];
  temporal?: boolean;
  height?: number;
  /**
   * Keep a blank or non-numeric cell as `null` (a GAP in the line) instead of coercing it to 0.
   * A raw query result needs this; a governed metric aggregate does not, because it always has a
   * number. Plotting a blank as 0 would be a fabricated value, which this product may not do.
   */
  nullable?: boolean;
};

/**
 * The ONE row→spec adapter. `categoryKey` absent (a single aggregate row) yields one empty
 * category, which is what a one-bar chart is. Values are coerced through {@link num}, so a chart
 * can never be handed `NaN` (ECharts drops it silently, which would be a hidden hole in a line).
 */
export function fromRows(input: FromRowsInput): ChartSpec {
  const { kind, rows, categoryKey, valueKeys, temporal, height, nullable } = input;
  const categories = rows.map((r) => String((categoryKey ? r[categoryKey] : '') ?? ''));
  const cell = (v: unknown): number | null => {
    if (!nullable) return num(v);
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    kind,
    categories,
    series: valueKeys.map((k) => ({ name: k, values: rows.map((r) => cell(r[k])) })),
    ...(temporal ? { temporal: true } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

/** The x-axis column name the vendored transformer keys on (never a user-supplied string). */
const X_AXIS = '__category';

/** The spec as the rows the vendored `extractSeries` expects: one record per category. */
function toDataRecords(spec: ChartSpec): DataRecord[] {
  return spec.categories.map((c, i) => {
    const row: DataRecord = { [X_AXIS]: c };
    for (const s of spec.series) row[s.name] = s.values[i] ?? null;
    return row;
  });
}

/**
 * Build the ECharts option for a spec. Line/area/bar go through the vendored Apache Superset
 * timeseries transformer; pie is built here. Returns `null` for a spec with nothing to draw
 * (no series, or a pie with no categories) — the host renders its own empty state rather than an
 * axis with no data, which reads as a broken chart.
 */
export function buildChartOption(spec: ChartSpec, colors: ChartColors): OsChartOption | null {
  if (spec.series.length === 0) return null;

  if (spec.kind === 'pie') {
    const measure = spec.series[0];
    if (spec.categories.length === 0) return null;
    return {
      tooltip: { trigger: 'item' },
      // ONE scrolling legend line at the bottom — many categories used to wrap over the pie.
      legend: { type: 'scroll', bottom: 0, itemGap: 10, textStyle: { color: colors.ink, fontSize: 11 } },
      color: colors.palette,
      series: [
        {
          type: 'pie',
          // The pie sits above the legend band (centre y 44%) so the two never collide.
          center: ['50%', '44%'],
          radius: ['36%', '60%'],
          itemStyle: { borderColor: colors.panel, borderWidth: 2 },
          label: { color: colors.ink, fontSize: 11, overflow: 'truncate', width: 90 },
          labelLine: { length: 8, length2: 6 },
          // Colliding slice labels HIDE instead of overlapping (the tooltip still names them).
          labelLayout: { hideOverlap: true },
          data: spec.categories.map((name, i) => ({ name, value: measure.values[i] })),
        },
      ],
    };
  }

  const multi = spec.series.length > 1;
  return transformTimeseries(toDataRecords(spec), {
    seriesType: spec.kind === 'bar' ? EchartsTimeseriesSeriesType.Bar : EchartsTimeseriesSeriesType.Smooth,
    xAxis: X_AXIS,
    // The category values arrive pre-stringified, so the axis is categorical. A real time axis
    // needs typed timestamps on the wire; until the governed result carries column types, saying
    // "temporal" would be a claim the data does not support (recorded in the stream's backlog).
    xAxisDataType: GenericDataType.String,
    xAxisForceCategorical: true,
    // Long/many bar categories rotate instead of overlapping each other under the bars.
    xAxisLabelRotation: spec.kind === 'bar' && spec.categories.length > 6 ? 30 : 0,
    area: spec.kind === 'area',
    markerEnabled: spec.kind !== 'bar',
    markerSize: 6,
    showLegend: multi,
    legendType: LegendType.Scroll,
    legendOrientation: LegendOrientation.Top,
    richTooltip: true,
    height: spec.height ?? 240,
    seriesLabel: leaf,
    // The author's declared measure order is the one the panel shows; upstream would sort it.
    seriesOrder: spec.series.map((s) => s.name),
    theme: { ink: colors.ink, line: colors.line, palette: colors.palette },
  });
}
