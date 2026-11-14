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
 * Modified from apache/superset superset-frontend/plugins/plugin-chart-echarts/src/constants.ts,
 *   src/defaults.ts, src/types.ts, src/Timeseries/types.ts,
 *   superset-frontend/packages/superset-ui-core/src/chart/types/Base.ts (AxisType),
 *   superset-frontend/packages/superset-core/src/common/index.ts (GenericDataType) and
 *   superset-frontend/packages/superset-ui-chart-controls/src/types.ts (SortSeriesType)
 *   @ c83fb2bb1dcfac41ac51bcebd82471f4a7180d18, by Borek Data Ventures UG
 *   (haftungsbeschränkt), 2026.
 * Changes:
 *   - The six upstream modules are collapsed into ONE declaration file, keeping only the enums,
 *     constants and structural types the vendored transformer slice actually uses. Nothing is
 *     re-exported that is not consumed.
 *   - Every upstream `enum` becomes a frozen `as const` object plus a union type of the same
 *     name, so `AxisType.Category` and `AxisType` both still read as upstream wrote them. Node's
 *     type-stripping loader (which runs this repo's test suite) refuses a TypeScript `enum`, and
 *     `const enum` is worse: it would inline across the vendor boundary. The VALUES are verbatim.
 *   - `GenericDataType` (upstream `packages/superset-core/src/common/index.ts`) is reduced to the
 *     three members the OS's governed model can produce (string / numeric / temporal); `BOOLEAN`
 *     is dropped because the metric layer never serves it. **Its values are changed:** upstream
 *     they are NUMERIC enum members (0, 1, 2, 3), here they are the strings 'STRING' / 'NUMERIC' /
 *     'TEMPORAL', because the enum became an `as const` object (below) and a numeric union would
 *     make `0` falsy in a `dataType === GenericDataType.String` check — the exact bug class the
 *     string form cannot have. Nothing crosses the vendor boundary as a number, so no upstream
 *     comparison changes meaning.
 *   - The ECharts option/series types are declared STRUCTURALLY here instead of importing
 *     `echarts`, so `os-ui/vendor/**` stays dependency-free and the OS's single-registration
 *     ratchet (`core/ui/charts/register.ts` is the only module allowed to name that package) holds.
 *   - `antd`, `@emotion`, `lodash`, `SupersetTheme` and the i18n `t()` helper are not imported:
 *     the theme arrives as plain resolved colours from `core/ui/charts/theme.ts`.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Upstream `superset-ui-core` `AxisType` (chart/types/Base.ts), verbatim. */
export const AxisType = {
  Category: 'category',
  Value: 'value',
  Time: 'time',
  Log: 'log',
} as const;
export type AxisType = (typeof AxisType)[keyof typeof AxisType];

/** Upstream `superset-ui-core` `GenericDataType`, narrowed to what the OS metric layer serves. */
export const GenericDataType = {
  String: 'STRING',
  Numeric: 'NUMERIC',
  Temporal: 'TEMPORAL',
} as const;
export type GenericDataType = (typeof GenericDataType)[keyof typeof GenericDataType];

/** Upstream `superset-ui-chart-controls` `SortSeriesType`, verbatim. */
export const SortSeriesType = {
  Name: 'name',
  Max: 'max',
  Min: 'min',
  Sum: 'sum',
  Avg: 'avg',
} as const;
export type SortSeriesType = (typeof SortSeriesType)[keyof typeof SortSeriesType];

/** Upstream `plugin-chart-echarts` `LegendOrientation`, verbatim. */
export const LegendOrientation = {
  Top: 'top',
  Bottom: 'bottom',
  Left: 'left',
  Right: 'right',
} as const;
export type LegendOrientation = (typeof LegendOrientation)[keyof typeof LegendOrientation];

/** Upstream `plugin-chart-echarts` `LegendType`, verbatim. */
export const LegendType = {
  Scroll: 'scroll',
  Plain: 'plain',
} as const;
export type LegendType = (typeof LegendType)[keyof typeof LegendType];

/** Upstream `plugin-chart-echarts` `StackControlsValue`, verbatim. */
export const StackControlsValue = {
  Stack: 'Stack',
  Stream: 'Stream',
  Expand: 'Expand',
} as const;
export type StackControlsValue = (typeof StackControlsValue)[keyof typeof StackControlsValue];

/** Upstream `plugin-chart-echarts` `StackType`. `Partial<enum>` collapses to the union itself
 *  once the enum is a union type, so it is written directly. */
export type StackType = boolean | null | StackControlsValue;

/** Upstream `plugin-chart-echarts/src/Timeseries/types.ts` `EchartsTimeseriesSeriesType`. */
export const EchartsTimeseriesSeriesType = {
  Line: 'line',
  Scatter: 'scatter',
  Smooth: 'smooth',
  Bar: 'bar',
  Start: 'start',
  Middle: 'middle',
  End: 'end',
} as const;
export type EchartsTimeseriesSeriesType = (typeof EchartsTimeseriesSeriesType)[keyof typeof EchartsTimeseriesSeriesType];

/** Upstream `plugin-chart-echarts/src/constants.ts` `NULL_STRING`, verbatim. */
export const NULL_STRING = '<NULL>';

/** Upstream `plugin-chart-echarts/src/constants.ts` `TIMESERIES_CONSTANTS`, verbatim. */
export const TIMESERIES_CONSTANTS = {
  gridOffsetRight: 20,
  gridOffsetLeft: 20,
  gridOffsetTop: 20,
  gridOffsetBottom: 20,
  gridOffsetBottomZoomable: 80,
  legendRightTopOffset: 30,
  legendTopRightOffset: 55,
  zoomBottom: 30,
  toolboxTop: 0,
  toolboxRight: 5,
  dataZoomStart: 0,
  dataZoomEnd: 100,
  yAxisLabelTopOffset: 20,
  extraControlsOffset: 22,
  horizontalBarLabelRightPadding: 70,
  compactChartHeight: 100,
  microChartHeight: 60,
  yAxisPixelsPerTick: 80,
};

/** Upstream `plugin-chart-echarts/src/defaults.ts` `defaultGrid`, verbatim. */
export const defaultGrid = {
  containLabel: true,
};

/** Upstream `plugin-chart-echarts/src/defaults.ts` `defaultLegendPadding`, verbatim. */
export const defaultLegendPadding: Record<LegendOrientation, number> = {
  [LegendOrientation.Top]: 20,
  [LegendOrientation.Bottom]: 20,
  [LegendOrientation.Left]: 170,
  [LegendOrientation.Right]: 170,
};

/** Upstream `superset-ui-chart-controls` `LegendPaddingType`, verbatim. */
export type LegendPaddingType = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
};

/** A cell of a result row. Upstream `DataRecordValue`, narrowed (no `Date` from the OS wire). */
export type DataRecordValue = string | number | boolean | Date | null | undefined;

/** One result row. Upstream `DataRecord`. */
export type DataRecord = Record<string, DataRecordValue>;

/**
 * An ECharts series, declared structurally. Upstream imports `SeriesOption` from `echarts`; the
 * OS cannot, because `core/ui/charts/register.ts` is the single module allowed to name that
 * package. Only the fields the vendored transformer sets or reads are declared.
 */
export type SeriesOption = {
  id?: string;
  name?: string;
  type?: string;
  data?: unknown[];
  stack?: string;
  smooth?: boolean;
  symbol?: string;
  symbolSize?: number;
  areaStyle?: Record<string, unknown>;
  itemStyle?: Record<string, unknown>;
  lineStyle?: Record<string, unknown>;
  barMaxWidth?: number;
  step?: string | false;
  showSymbol?: boolean;
};

/** The padding an upstream `getChartPadding` returns. */
export type ChartPadding = { bottom: number; left: number; right: number; top: number };
