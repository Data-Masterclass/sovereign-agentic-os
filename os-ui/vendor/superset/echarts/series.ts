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
 *   superset-frontend/plugins/plugin-chart-echarts/src/utils/series.ts
 *   @ c83fb2bb1dcfac41ac51bcebd82471f4a7180d18, by Borek Data Ventures UG
 *   (haftungsbeschränkt), 2026.
 * Changes:
 *   - Only the PURE series algebra is taken: sortAndFilterSeries, sortRows, extractSeries,
 *     formatSeriesName, extractGroupbyLabel, dedupSeries, getChartPadding, getAxisType,
 *     calculateLowerLogTick and getMinAndMaxFromBounds. Everything that measures DOM text,
 *     reads a `SupersetTheme`, builds a legend layout, or touches the forecast/tooltip/legend-state
 *     machinery is left upstream — it is Flask- or Emotion-coupled, or it belongs to a feature the
 *     OS has not built.
 *   - `lodash` (sumBy/minBy/maxBy/meanBy/orderBy/isEmpty) is replaced by the small pure local
 *     helpers below, because os-ui does not depend on lodash and will not start for a vendored
 *     slice. `orderBy` is reimplemented as a STABLE multi-key sort with lodash's own
 *     null-last/undefined-last ordering, which is the behaviour the upstream call sites rely on.
 *   - `@superset-ui/core` imports (DTTM_ALIAS, ensureIsArray, normalizeTimestamp, the formatter
 *     classes) are replaced by local equivalents or by narrowed parameters; types come from
 *     `./types.ts` rather than from `echarts` / `@apache-superset/core`.
 *   - `LegendState`, `extraMetricLabels` behaviour and the `isHorizontal` axis swap are kept
 *     verbatim; `getLegendProps` is NOT taken (it needs SupersetTheme) — `core/ui/charts` builds
 *     the legend from the OS palette instead.
 *   - `sanitizeHtml` is dropped: it wrapped `echarts/core`'s `format.encodeHTML`, which this tree
 *     may not import.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  AxisType,
  GenericDataType,
  LegendOrientation,
  NULL_STRING,
  SortSeriesType,
  StackControlsValue,
  EchartsTimeseriesSeriesType,
  defaultLegendPadding,
  type ChartPadding,
  type DataRecord,
  type DataRecordValue,
  type LegendPaddingType,
  type SeriesOption,
  type StackType,
} from './types';

/** The default x-axis alias upstream reads from `@superset-ui/core` as `DTTM_ALIAS`. */
export const DTTM_ALIAS = '__timestamp';

function isDefined<T>(value: T | undefined | null): boolean {
  return value !== undefined && value !== null;
}

// ------------------------------------------------------- local lodash replacements ---

function numbersOf(rows: DataRecord[], key: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = row[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** `lodash.sumBy(rows, key)` over numeric cells (lodash yields 0 for an all-null column). */
function sumBy(rows: DataRecord[], key: string): number {
  return numbersOf(rows, key).reduce((a, b) => a + b, 0);
}

/** `lodash.meanBy(rows, key)` — NaN for an empty set, as lodash returns. */
function meanBy(rows: DataRecord[], key: string): number {
  const ns = numbersOf(rows, key);
  return ns.length === 0 ? NaN : ns.reduce((a, b) => a + b, 0) / ns.length;
}

/** `lodash.minBy(rows, key)?.[key]`. */
function minValueBy(rows: DataRecord[], key: string): number | undefined {
  const ns = numbersOf(rows, key);
  return ns.length === 0 ? undefined : Math.min(...ns);
}

/** `lodash.maxBy(rows, key)?.[key]`. */
function maxValueBy(rows: DataRecord[], key: string): number | undefined {
  const ns = numbersOf(rows, key);
  return ns.length === 0 ? undefined : Math.max(...ns);
}

/** lodash's comparison order: `undefined` last, then `null`, then values by `<`. */
function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
    if (Number.isNaN(b)) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** `lodash.orderBy(items, keys, dirs)` — stable, with lodash's null/undefined-last ordering. */
function orderBy<T extends Record<string, unknown>>(items: T[], keys: string[], dirs: ('asc' | 'desc')[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((l, r) => {
      for (let i = 0; i < keys.length; i += 1) {
        const c = cmp(l.item[keys[i]], r.item[keys[i]]);
        if (c !== 0) return (dirs[i] ?? 'asc') === 'asc' ? c : -c;
      }
      return l.index - r.index; // stable
    })
    .map(({ item }) => item);
}

/** `@superset-ui/core` `ensureIsArray`. */
function ensureIsArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// ----------------------------------------------------------------- the vendored slice ---

/**
 * The series names present on `rows`, minus the x-axis and any extra-metric columns, ordered by
 * `sortSeriesType` (name / sum / min / max / avg). Upstream behaviour, verbatim.
 */
export function sortAndFilterSeries(
  rows: DataRecord[],
  xAxis: string,
  extraMetricLabels: string[],
  sortSeriesType?: SortSeriesType,
  sortSeriesAscending?: boolean,
): string[] {
  if (rows.length === 0) return [];
  const seriesNames = Object.keys(rows[0])
    .filter((key) => key !== xAxis)
    .filter((key) => !extraMetricLabels.includes(key));

  let aggregator: (name: string) => { name: string; value: number | undefined };

  switch (sortSeriesType) {
    case SortSeriesType.Sum:
      aggregator = (name) => ({ name, value: sumBy(rows, name) });
      break;
    case SortSeriesType.Min:
      aggregator = (name) => ({ name, value: minValueBy(rows, name) });
      break;
    case SortSeriesType.Max:
      aggregator = (name) => ({ name, value: maxValueBy(rows, name) });
      break;
    case SortSeriesType.Avg:
      aggregator = (name) => ({ name, value: meanBy(rows, name) });
      break;
    default: {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      return seriesNames.sort((a, b) => (sortSeriesAscending ? collator.compare(a, b) : collator.compare(b, a)));
    }
  }

  const sortedValues = seriesNames.map(aggregator);
  return orderBy(sortedValues, ['value', 'name'], [sortSeriesAscending ? 'asc' : 'desc', 'asc']).map(({ name }) => name);
}

/**
 * Order the ROWS of a multi-series chart by an aggregate across their measures (or by the x-axis
 * value for `SortSeriesType.Name`), carrying each row's stacked total with it. Upstream, verbatim.
 */
export function sortRows(
  rows: DataRecord[],
  totalStackedValues: number[],
  xAxis: string,
  xAxisSortSeries: SortSeriesType,
  xAxisSortSeriesAscending: boolean,
): { row: DataRecord; totalStackedValue: number }[] {
  const sortedRows = rows.map((row, idx) => {
    let sortKey: DataRecordValue = '';
    let aggregate: number | undefined;
    let entries = 0;
    Object.entries(row).forEach(([key, value]) => {
      const isValueDefined = isDefined(value);
      if (key === xAxis) {
        sortKey = value;
      }
      if (xAxisSortSeries === SortSeriesType.Name || typeof value !== 'number') {
        return;
      }
      if (!(xAxisSortSeries === SortSeriesType.Avg && !isValueDefined)) {
        entries += 1;
      }
      switch (xAxisSortSeries) {
        case SortSeriesType.Avg:
        case SortSeriesType.Sum:
          if (aggregate === undefined) aggregate = value;
          else aggregate += value;
          break;
        case SortSeriesType.Min:
          aggregate = aggregate === undefined || (isValueDefined && value < aggregate) ? value : aggregate;
          break;
        case SortSeriesType.Max:
          aggregate = aggregate === undefined || (isValueDefined && value > aggregate) ? value : aggregate;
          break;
        default:
          break;
      }
    });
    if (xAxisSortSeries === SortSeriesType.Avg && entries > 0 && aggregate !== undefined) {
      aggregate /= entries;
    }
    const value =
      xAxisSortSeries === SortSeriesType.Name
        ? typeof sortKey === 'string'
          ? sortKey.toLowerCase()
          : sortKey
        : aggregate;
    return { key: sortKey, value, row, totalStackedValue: totalStackedValues[idx] };
  });

  return orderBy(
    sortedRows as unknown as Record<string, unknown>[],
    ['value'],
    [xAxisSortSeriesAscending ? 'asc' : 'desc'],
  ).map((r) => {
    const e = r as unknown as { row: DataRecord; totalStackedValue: number };
    return { row: e.row, totalStackedValue: e.totalStackedValue };
  });
}

export type ExtractSeriesOptions = {
  fillNeighborValue?: number;
  xAxis?: string;
  extraMetricLabels?: string[];
  removeNulls?: boolean;
  stack?: StackType;
  totalStackedValues?: number[];
  isHorizontal?: boolean;
  sortSeriesType?: SortSeriesType;
  sortSeriesAscending?: boolean;
  xAxisSortSeries?: SortSeriesType;
  xAxisSortSeriesAscending?: boolean;
  xAxisType?: AxisType;
};

/**
 * `(rows, options) → [series, sortedTotals, minPositiveValue]` — the heart of the upstream
 * ECharts plugin: one `SeriesOption` per measure column, each carrying `[x, y]` pairs (swapped for
 * a horizontal orientation), with neighbour filling, `Expand` stacking normalisation and the
 * smallest positive value (which a log axis needs for its lower tick). Upstream, verbatim.
 */
export function extractSeries(
  data: DataRecord[],
  opts: ExtractSeriesOptions = {},
): [SeriesOption[], number[], number | undefined] {
  const {
    fillNeighborValue,
    xAxis = DTTM_ALIAS,
    extraMetricLabels = [],
    removeNulls = false,
    stack = false,
    totalStackedValues = [],
    isHorizontal = false,
    sortSeriesType,
    sortSeriesAscending,
    xAxisSortSeries,
    xAxisSortSeriesAscending,
    xAxisType,
  } = opts;
  if (data.length === 0) return [[], [], undefined];
  const rows: DataRecord[] = data.map((datum) => ({
    ...datum,
    [xAxis]: datum[xAxis] === null && xAxisType === AxisType.Category ? NULL_STRING : datum[xAxis],
  }));
  const sortedSeries = sortAndFilterSeries(rows, xAxis, extraMetricLabels, sortSeriesType, sortSeriesAscending);
  const sortedRows =
    isDefined(xAxisSortSeries) && isDefined(xAxisSortSeriesAscending)
      ? sortRows(rows, totalStackedValues, xAxis, xAxisSortSeries!, xAxisSortSeriesAscending!)
      : rows.map((row, idx) => ({ row, totalStackedValue: totalStackedValues[idx] }));

  let minPositiveValue: number | undefined;
  const finalSeries: SeriesOption[] = sortedSeries.map((name) => ({
    id: name,
    name,
    data: sortedRows
      .map(({ row, totalStackedValue }, idx) => {
        const currentValue = row[name];
        if (
          typeof currentValue === 'number' &&
          currentValue > 0 &&
          (minPositiveValue === undefined || minPositiveValue > currentValue)
        ) {
          minPositiveValue = currentValue;
        }
        const isNextToDefinedValue = isDefined(rows[idx - 1]?.[name]) || isDefined(rows[idx + 1]?.[name]);
        const isFillNeighborValue = !isDefined(currentValue) && isNextToDefinedValue && fillNeighborValue !== undefined;
        let value: DataRecordValue | undefined = currentValue;
        if (isFillNeighborValue) {
          value = fillNeighborValue;
        } else if (stack === StackControlsValue.Expand && totalStackedValue !== undefined) {
          value = ((value || 0) as number) / totalStackedValue;
        }
        return [row[xAxis], value];
      })
      .filter((obs) => !removeNulls || (obs[0] !== null && obs[1] !== null))
      .map((obs) => (isHorizontal ? [obs[1], obs[0]] : obs)),
  }));
  return [finalSeries, sortedRows.map(({ totalStackedValue }) => totalStackedValue), minPositiveValue];
}

/** A number/time/boolean/null cell rendered as a series or legend label. Upstream, verbatim. */
export function formatSeriesName(
  name: DataRecordValue | undefined,
  {
    numberFormatter,
    timeFormatter,
    coltype,
  }: {
    numberFormatter?: (n: number) => string;
    timeFormatter?: (d: Date) => string;
    coltype?: GenericDataType;
  } = {},
): string {
  if (name === undefined || name === null) {
    return NULL_STRING;
  }
  if (typeof name === 'boolean') {
    return name.toString();
  }
  if (name instanceof Date || coltype === GenericDataType.Temporal) {
    const d = name instanceof Date ? name : new Date(name as string | number);
    return timeFormatter ? timeFormatter(d) : d.toISOString();
  }
  if (typeof name === 'number') {
    return numberFormatter ? numberFormatter(name) : name.toString();
  }
  return name;
}

/** The comma-joined group-by label of one row. Upstream, verbatim. */
export function extractGroupbyLabel({
  datum = {},
  groupby,
  numberFormatter,
  timeFormatter,
  coltypeMapping = {},
}: {
  datum?: DataRecord;
  groupby?: string[] | null;
  numberFormatter?: (n: number) => string;
  timeFormatter?: (d: Date) => string;
  coltypeMapping?: Record<string, GenericDataType>;
}): string {
  return ensureIsArray(groupby)
    .map((val) =>
      formatSeriesName(datum[val], {
        numberFormatter,
        timeFormatter,
        ...(coltypeMapping[val] && { coltype: coltypeMapping[val] }),
      }),
    )
    .join(', ');
}

/** The grid padding a legend of this orientation needs. Upstream, verbatim. */
export function getChartPadding(
  show: boolean,
  orientation: LegendOrientation,
  margin?: string | number | null,
  padding?: LegendPaddingType,
  isHorizontal?: boolean,
): ChartPadding {
  let legendMargin: number;
  if (!show) {
    legendMargin = 0;
  } else if (margin === null || margin === undefined || typeof margin === 'string') {
    legendMargin = defaultLegendPadding[orientation];
  } else {
    legendMargin = margin;
  }

  const { bottom = 0, left = 0, right = 0, top = 0 } = padding || {};

  if (isHorizontal) {
    return {
      left: left + (orientation === LegendOrientation.Bottom ? legendMargin : 0),
      right: right + (orientation === LegendOrientation.Right ? legendMargin : 0),
      top: top + (orientation === LegendOrientation.Top ? legendMargin : 0),
      bottom: bottom + (orientation === LegendOrientation.Left ? legendMargin : 0),
    };
  }

  return {
    left: left + (orientation === LegendOrientation.Left ? legendMargin : 0),
    right: right + (orientation === LegendOrientation.Right ? legendMargin : 0),
    top: top + (orientation === LegendOrientation.Top ? legendMargin : 0),
    bottom: bottom + (orientation === LegendOrientation.Bottom ? legendMargin : 0),
  };
}

/** Make duplicate series ids unique (`revenue`, `revenue (1)`, …). Upstream, verbatim. */
export function dedupSeries(series: SeriesOption[]): SeriesOption[] {
  const counter = new Map<string, number>();
  return series.map((row) => {
    let { id } = row;
    if (id === undefined) return row;
    id = String(id);
    const count = counter.get(id) || 0;
    const suffix = count > 0 ? ` (${count})` : '';
    counter.set(id, count + 1);
    return { ...row, id: `${id}${suffix}` };
  });
}

/** Which ECharts axis type a column of this data type deserves. Upstream, verbatim. */
export function getAxisType(
  stack: StackType,
  forceCategorical?: boolean,
  dataType?: GenericDataType,
  seriesType?: EchartsTimeseriesSeriesType,
): AxisType {
  if (forceCategorical) {
    return AxisType.Category;
  }
  if (dataType === GenericDataType.Temporal) {
    return AxisType.Time;
  }
  if (dataType === GenericDataType.Numeric && !stack && seriesType !== EchartsTimeseriesSeriesType.Bar) {
    return AxisType.Value;
  }
  return AxisType.Category;
}

/** The power-of-ten tick below the smallest positive value, for a log axis. Upstream, verbatim. */
export function calculateLowerLogTick(minPositiveValue: number): number {
  const logBase10 = Math.floor(Math.log10(minPositiveValue));
  return Math.pow(10, logBase10);
}

export type BoundsType = {
  min?: number | 'dataMin';
  max?: number | 'dataMax';
  scale?: true;
};

/** The axis bounds an explicit min/max + "truncate axis" imply. Upstream, verbatim. */
export function getMinAndMaxFromBounds(
  axisType: AxisType,
  truncateAxis: boolean,
  min?: number,
  max?: number,
  seriesType?: EchartsTimeseriesSeriesType,
): BoundsType {
  if (axisType === AxisType.Value && truncateAxis) {
    const ret: BoundsType = {};
    if (seriesType === EchartsTimeseriesSeriesType.Bar) {
      ret.scale = true;
    }
    if (min !== undefined) {
      ret.min = min;
    } else if (seriesType !== EchartsTimeseriesSeriesType.Bar) {
      ret.min = 'dataMin';
    }
    if (max !== undefined) {
      ret.max = max;
    } else if (seriesType !== EchartsTimeseriesSeriesType.Bar) {
      ret.max = 'dataMax';
    }
    return ret;
  }
  return {};
}
