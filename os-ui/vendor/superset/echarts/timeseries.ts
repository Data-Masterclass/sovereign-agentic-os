/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
/*
 * Modified from apache/superset
 *   superset-frontend/plugins/plugin-chart-echarts/src/Timeseries/transformProps.ts and
 *   superset-frontend/plugins/plugin-chart-echarts/src/Timeseries/transformers.ts
 *   @ c83fb2bb1dcfac41ac51bcebd82471f4a7180d18, by Borek Data Ventures UG
 *   (haftungsbeschränkt), 2026.
 * Changes:
 *   - Ported to the OS's governed result shape. Upstream takes a Superset `ChartProps`
 *     (queriesData[0].data + rawFormData + a datasource + a colorScale + a SupersetTheme);
 *     this takes `(rows, TimeseriesFormData)` where `rows` are the rows `runPanelQuery` already
 *     resolved as the viewer, and the theme arrives as plain resolved colours.
 *   - EVERYTHING forecast-related is removed: `rebaseForecastDatum`,
 *     `extractForecastSeriesContexts`, `reorderForecastSeries`, the confidence-band series and the
 *     forecast tooltip rows. The OS has no forecast feature, and half a forecast renderer would be
 *     a surface that can show a band with nothing behind it.
 *   - Also removed: annotation layers, `dataZoom`/toolbox, cross-filter `emphasis` wiring,
 *     the context menu, `onlyTotal`/`percentageThreshold` total labels, `extractDataTotalValues`,
 *     time-comparison (`timeShiftColor`, `getTimeCompareStackId`), the custom `tooltip.formatter`
 *     (which is a React/Emotion-rendered HTML table upstream — the OS uses ECharts' own tooltip),
 *     `colorByPrimaryAxis` and the horizontal-orientation axis swap. Each is a named backlog item
 *     in the stream's report rather than a half-built path.
 *   - `transformSeries` is narrowed to the branches the OS's `VizType` union can reach
 *     (line · area · bar · smooth · scatter · step), with the colour taken from the OS palette by
 *     index instead of from Superset's `CategoricalColorScale`.
 *   - ADDED `seriesOrder`: upstream ALWAYS sorts the series (its default branch orders them
 *     reverse-alphabetically), which would silently reorder the measures a panel author declared.
 *     When `seriesOrder` is given, the extracted series are put back into that order before
 *     `transformSeries` runs, so the palette index matches the declared position too. Upstream's
 *     `sortSeriesType` / `sortSeriesAscending` still apply when it is absent.
 *   - Types come from `./types.ts`; no `echarts`, `lodash`, `antd`, `@emotion` or `@superset-ui/*`
 *     import exists in this file (see `./types.ts` for why).
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  AxisType,
  EchartsTimeseriesSeriesType,
  GenericDataType,
  LegendOrientation,
  LegendType,
  StackControlsValue,
  TIMESERIES_CONSTANTS,
  defaultGrid,
  type ChartPadding,
  type DataRecord,
  type LegendPaddingType,
  type SeriesOption,
  type SortSeriesType,
  type StackType,
} from './types';
import {
  calculateLowerLogTick,
  dedupSeries,
  extractSeries,
  getAxisType,
  getChartPadding,
  getMinAndMaxFromBounds,
} from './series';

/** The resolved colours the OS hands in instead of a `SupersetTheme`. */
export type TimeseriesTheme = {
  /** Axis + label text colour. */
  ink: string;
  /** Grid + axis line colour. */
  line: string;
  /** The categorical series palette, used by index. */
  palette: string[];
};

/** The upstream `EchartsTimeseriesFormData`, narrowed to the controls the OS exposes. */
export type TimeseriesFormData = {
  seriesType: EchartsTimeseriesSeriesType;
  /** The x-axis column on `rows`. */
  xAxis: string;
  /** The data type of the x-axis column — decides category vs time vs value axis. */
  xAxisDataType?: GenericDataType;
  xAxisForceCategorical?: boolean;
  xAxisLabelRotation?: number;
  xAxisTitle?: string;
  yAxisTitle?: string;
  area?: boolean;
  areaOpacity?: number;
  opacity?: number;
  stack?: StackType;
  markerEnabled?: boolean;
  markerSize?: number;
  logAxis?: boolean;
  minorTicks?: boolean;
  minorSplitLine?: boolean;
  truncateXAxis?: boolean;
  truncateYAxis?: boolean;
  xAxisMin?: number;
  xAxisMax?: number;
  yAxisMin?: number;
  yAxisMax?: number;
  showLegend?: boolean;
  legendType?: LegendType;
  legendOrientation?: LegendOrientation;
  legendMargin?: number | null;
  legendPadding?: LegendPaddingType;
  richTooltip?: boolean;
  sortSeriesType?: SortSeriesType;
  sortSeriesAscending?: boolean;
  xAxisSortSeries?: SortSeriesType;
  xAxisSortSeriesAscending?: boolean;
  /** Chart height in px — drives the upstream three-tier responsive y-axis. */
  height?: number;
  /** Rename a series for its legend/axis label (the OS passes `leaf(member)`). */
  seriesLabel?: (name: string) => string;
  /**
   * OS addition (see the file header): the series names in the order the author declared them.
   * Absent ⇒ upstream's `sortSeriesType` ordering applies.
   */
  seriesOrder?: string[];
  theme: TimeseriesTheme;
};

/** The ECharts option this transformer returns, declared structurally (see `./types.ts`). */
export type TimeseriesOption = {
  useUTC: true;
  color: string[];
  grid: Record<string, unknown>;
  xAxis: Record<string, unknown>;
  yAxis: Record<string, unknown>;
  tooltip: Record<string, unknown>;
  legend?: Record<string, unknown>;
  series: SeriesOption[];
};

const DEFAULT_OPACITY = 1;
const DEFAULT_AREA_OPACITY = 0.14;

/**
 * One `SeriesOption` from one extracted series. Upstream `transformSeries`, narrowed to the
 * branches the OS can reach: the forecast/confidence-band, time-shift, total-label and
 * cross-filter-emphasis paths are gone (see the file header).
 */
export function transformSeries(
  series: SeriesOption,
  index: number,
  fd: TimeseriesFormData,
): SeriesOption {
  const {
    seriesType,
    area = false,
    areaOpacity = DEFAULT_AREA_OPACITY,
    opacity = DEFAULT_OPACITY,
    stack = false,
    markerEnabled = false,
    markerSize = 6,
    richTooltip = true,
    seriesLabel,
    theme,
  } = fd;

  // Upstream: 'scatter' stays scatter, 'bar' stays bar, everything else draws as a line.
  const plotType = seriesType === EchartsTimeseriesSeriesType.Scatter ? 'scatter' : seriesType === EchartsTimeseriesSeriesType.Bar ? 'bar' : 'line';
  const color = theme.palette[index % Math.max(theme.palette.length, 1)];

  // Upstream's showSymbol ladder, minus the forecast and cross-filter branches.
  let showSymbol = false;
  if (plotType === 'scatter') showSymbol = true;
  else if (plotType === 'line' && !richTooltip && !markerEnabled) showSymbol = true;
  else if (markerEnabled) showSymbol = true;

  const stackId = stack ? String(stack) : undefined;

  return {
    ...series,
    name: seriesLabel ? seriesLabel(String(series.name ?? '')) : series.name,
    type: plotType,
    smooth: seriesType === EchartsTimeseriesSeriesType.Smooth,
    step: ([EchartsTimeseriesSeriesType.Start, EchartsTimeseriesSeriesType.Middle, EchartsTimeseriesSeriesType.End] as string[]).includes(
      seriesType as string,
    )
      ? (seriesType as string)
      : undefined,
    ...(stackId ? { stack: stackId } : {}),
    itemStyle: { color, opacity, borderWidth: 0 },
    lineStyle: { opacity, ...(plotType === 'bar' ? {} : { color }) },
    areaStyle: area ? { opacity: opacity * areaOpacity, color } : undefined,
    ...(plotType === 'bar' ? { barMaxWidth: 42, itemStyle: { color, opacity, borderWidth: 0, borderRadius: [4, 4, 0, 0] } } : {}),
    showSymbol,
    symbol: showSymbol ? 'circle' : 'none',
    symbolSize: markerSize,
  };
}

/**
 * `(rows, formData) → EChartsOption` for a timeseries-family chart. Upstream
 * `Timeseries/transformProps.ts`, ported to the OS result shape and narrowed as the header
 * records. The pure part — series extraction, axis typing, grid padding, log-axis lower tick and
 * the explicit-bounds algebra — is upstream's, which is the whole point of vendoring it.
 */
export function transformTimeseries(rows: DataRecord[], fd: TimeseriesFormData): TimeseriesOption {
  const {
    seriesType,
    xAxis: xAxisLabel,
    xAxisDataType,
    xAxisForceCategorical,
    xAxisLabelRotation = 0,
    xAxisTitle,
    yAxisTitle,
    stack = false,
    logAxis = false,
    minorTicks = false,
    minorSplitLine = false,
    truncateXAxis = false,
    truncateYAxis = false,
    xAxisMin,
    xAxisMax,
    yAxisMin,
    yAxisMax,
    showLegend = false,
    legendType = LegendType.Scroll,
    legendOrientation = LegendOrientation.Top,
    legendMargin = null,
    legendPadding,
    richTooltip = true,
    sortSeriesType,
    sortSeriesAscending,
    xAxisSortSeries,
    xAxisSortSeriesAscending,
    seriesOrder,
    height = 240,
    theme,
  } = fd;

  const xAxisType = getAxisType(stack, xAxisForceCategorical, xAxisDataType, seriesType);

  const [rawSeries, , minPositiveValue] = extractSeries(rows, {
    // Upstream fills a neighbour with 0 when stacking, so a stack does not show a hole.
    fillNeighborValue: stack ? 0 : undefined,
    xAxis: xAxisLabel,
    stack,
    sortSeriesType,
    sortSeriesAscending,
    xAxisSortSeries,
    xAxisSortSeriesAscending,
    xAxisType,
  });

  // OS addition: honour the author's declared measure order (see the file header). Any series
  // upstream produced that the caller did not name keeps its relative position at the end, so a
  // partial `seriesOrder` can never drop a series from the chart.
  const ordered = seriesOrder
    ? [
        ...seriesOrder.map((name) => rawSeries.find((s) => s.name === name)).filter((s): s is SeriesOption => s !== undefined),
        ...rawSeries.filter((s) => !seriesOrder.includes(String(s.name ?? ''))),
      ]
    : rawSeries;

  const series = dedupSeries(ordered.map((s, i) => transformSeries(s, i, fd)));

  const padding: ChartPadding = getChartPadding(showLegend, legendOrientation, legendMargin, legendPadding);

  const axisText = { color: theme.ink, fontSize: 11 };
  const axisLine = { lineStyle: { color: theme.line } };

  const xAxisOption: Record<string, unknown> = {
    type: xAxisType,
    ...(xAxisTitle ? { name: xAxisTitle, nameLocation: 'middle', nameGap: 28 } : {}),
    axisLabel: {
      ...axisText,
      // Upstream: rotated labels already overlap less, so hideOverlap is only kept at 0°.
      hideOverlap: !(xAxisType === AxisType.Time && xAxisLabelRotation !== 0),
      rotate: xAxisLabelRotation,
      width: 90,
      overflow: 'truncate',
    },
    axisLine,
    minorTick: { show: minorTicks },
    ...getMinAndMaxFromBounds(xAxisType, truncateXAxis, xAxisMin, xAxisMax, seriesType),
  };

  // Upstream's three-tier responsive y-axis: >=100px full, 60-99px min/max only, <60px bare.
  const isSmallChart = height < TIMESERIES_CONSTANTS.compactChartHeight;
  const isMicroChart = height < TIMESERIES_CONSTANTS.microChartHeight;
  const yAxisSplitNumber = isMicroChart
    ? undefined
    : isSmallChart
      ? 1
      : Math.max(3, Math.floor(height / TIMESERIES_CONSTANTS.yAxisPixelsPerTick));

  const yAxisOption: Record<string, unknown> = {
    scale: truncateYAxis,
    type: logAxis ? AxisType.Log : AxisType.Value,
    ...(yAxisSplitNumber !== undefined ? { splitNumber: yAxisSplitNumber } : {}),
    // Upstream: a log axis with an explicit-free minimum starts at the power of ten below the
    // smallest positive value, or ECharts picks 0 and renders nothing.
    min: logAxis && yAxisMin === undefined && minPositiveValue !== undefined ? calculateLowerLogTick(minPositiveValue) : yAxisMin,
    max: yAxisMax,
    minorTick: { show: isSmallChart ? false : minorTicks },
    minorSplitLine: { show: isSmallChart ? false : minorSplitLine },
    splitLine: { show: !isSmallChart, lineStyle: { color: theme.line } },
    axisLabel: {
      ...axisText,
      show: !isMicroChart,
      showMinLabel: !isMicroChart,
      showMaxLabel: !isMicroChart,
      hideOverlap: true,
    },
    axisTick: { show: !isSmallChart },
    ...(isSmallChart || !yAxisTitle ? {} : { name: yAxisTitle, nameLocation: 'end', nameGap: 12 }),
  };

  const option: TimeseriesOption = {
    useUTC: true,
    color: theme.palette,
    grid: { ...defaultGrid, ...padding, left: 8, right: 12, bottom: 8, top: showLegend ? 34 : 24 },
    xAxis: xAxisOption,
    yAxis: yAxisOption,
    tooltip: { trigger: richTooltip ? 'axis' : 'item' },
    series,
  };
  if (showLegend) {
    option.legend = {
      type: legendType,
      top: 0,
      itemGap: 12,
      textStyle: { color: theme.ink, fontSize: 11 },
      data: series.map((s) => String(s.name ?? '')),
    };
  }
  return option;
}

/** The stack value upstream uses for a plain (non-stream, non-expand) stack. */
export const DEFAULT_STACK = StackControlsValue.Stack;
