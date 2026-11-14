/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The shared chart surface — formatters, theme bridge, spec builder, vendored transform
 * USER STORY: As a developer I want proof that the same rows drawn by two different hosts produce
 *             the identical ECharts option, and that the vendored Apache Superset transformer is
 *             really the thing building the series (D1, D7).
 * ARCHITECTURE:
 *   - Pure modules only (`format.ts`, `theme.ts`, `spec.ts`, `vendor/superset/echarts/*`); the
 *     React shell and the `echarts` registration are never imported here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSlug, fmtCompact, leaf, num, toCsv } from '@core/ui/charts/format';
import { CHART_CSS_VARS, resolveChartColors } from '@core/ui/charts/theme';
import { buildChartOption, fromRows, type ChartSpec } from '@core/ui/charts/spec';
import { extractSeries, dedupSeries, getAxisType, getMinAndMaxFromBounds, sortAndFilterSeries, calculateLowerLogTick } from '../../../vendor/superset/echarts/series';
import { AxisType, EchartsTimeseriesSeriesType, GenericDataType, SortSeriesType } from '../../../vendor/superset/echarts/types';

const COLORS = resolveChartColors(() => undefined);

// ------------------------------------------------------------------ formatters ---

test('leaf takes the member leaf; num never yields NaN', () => {
  assert.equal(leaf('Orders.revenue'), 'revenue');
  assert.equal(leaf('revenue'), 'revenue');
  assert.equal(num('12.5'), 12.5);
  assert.equal(num('not a number'), 0);
  assert.equal(num(null), 0);
  assert.equal(num(undefined), 0);
});

test('fmtCompact is the one compact-number rule', () => {
  assert.equal(fmtCompact(1_234_567), '1.2M');
  assert.equal(fmtCompact(2_500_000_000), '2.5B');
  assert.equal(fmtCompact(34_500), '34.5k');
  assert.equal(fmtCompact(812), '812');
  assert.equal(fmtCompact(0.5), '0.50');
  assert.equal(fmtCompact(Number.NaN), '—');
});

test('toCsv exports the rendered rows with leaf headers, quoted and escaped', () => {
  const csv = toCsv(['Orders.region', 'Orders.revenue'], [
    { 'Orders.region': 'DE', 'Orders.revenue': 10 },
    { 'Orders.region': 'Berlin, DE', 'Orders.revenue': 20 },
    { 'Orders.region': 'say "hi"', 'Orders.revenue': null },
  ]);
  assert.equal(csv, 'region,revenue\nDE,10\n"Berlin, DE",20\n"say ""hi""",');
});

test('fileSlug falls back rather than producing an empty filename', () => {
  assert.equal(fileSlug('Sales Overview', 'table'), 'sales-overview');
  assert.equal(fileSlug('***', 'table'), 'table');
});

// ----------------------------------------------------------------- theme bridge ---

test('the theme bridge falls back to the brand palette when no CSS variable is set', () => {
  assert.equal(COLORS.teal, CHART_CSS_VARS.teal[1]);
  assert.equal(COLORS.palette[0], COLORS.teal);
  assert.equal(COLORS.palette[1], COLORS.gold);
  assert.equal(COLORS.palette.length, 5);
});

test('the theme bridge prefers the live CSS variable and ignores whitespace-only values', () => {
  const c = resolveChartColors((name) => (name === '--teal' ? '  #112233  ' : '   '));
  assert.equal(c.teal, '#112233');
  assert.equal(c.gold, CHART_CSS_VARS.gold[1], 'a blank variable must fall back, not blank the chart');
  assert.equal(c.palette[0], '#112233');
});

// ------------------------------------------------- the vendored Superset algebra ---

test('vendored extractSeries builds one series per measure column, in sorted order', () => {
  const [series, , minPositive] = extractSeries(
    [
      { x: 'a', revenue: 10, orders: 2 },
      { x: 'b', revenue: 30, orders: 1 },
    ],
    { xAxis: 'x', sortSeriesType: SortSeriesType.Name, sortSeriesAscending: true },
  );
  assert.deepEqual(series.map((s) => s.name), ['orders', 'revenue']);
  assert.deepEqual(series[1].data, [['a', 10], ['b', 30]]);
  assert.equal(minPositive, 1);
});

test('vendored extractSeries orders series by an aggregate when asked', () => {
  const rows = [
    { x: 'a', small: 1, big: 100 },
    { x: 'b', small: 2, big: 200 },
  ];
  assert.deepEqual(sortAndFilterSeries(rows, 'x', [], SortSeriesType.Sum, false), ['big', 'small']);
  assert.deepEqual(sortAndFilterSeries(rows, 'x', [], SortSeriesType.Sum, true), ['small', 'big']);
});

test('vendored extractSeries excludes extra metric labels and handles an empty result', () => {
  const [empty] = extractSeries([], { xAxis: 'x' });
  assert.deepEqual(empty, []);
  const [series] = extractSeries([{ x: 'a', revenue: 1, helper: 9 }], { xAxis: 'x', extraMetricLabels: ['helper'] });
  assert.deepEqual(series.map((s) => s.name), ['revenue']);
});

test('vendored dedupSeries makes duplicate ids unique', () => {
  assert.deepEqual(
    dedupSeries([{ id: 'revenue' }, { id: 'revenue' }, { id: 'orders' }]).map((s) => s.id),
    ['revenue', 'revenue (1)', 'orders'],
  );
});

test('vendored getAxisType and getMinAndMaxFromBounds keep upstream behaviour', () => {
  assert.equal(getAxisType(false, true, GenericDataType.Numeric), AxisType.Category);
  assert.equal(getAxisType(false, false, GenericDataType.Temporal), AxisType.Time);
  assert.equal(getAxisType(false, false, GenericDataType.Numeric), AxisType.Value);
  assert.equal(getAxisType(false, false, GenericDataType.Numeric, EchartsTimeseriesSeriesType.Bar), AxisType.Category);
  assert.deepEqual(getMinAndMaxFromBounds(AxisType.Value, false, 1, 2), {});
  assert.deepEqual(getMinAndMaxFromBounds(AxisType.Value, true, undefined, undefined), { min: 'dataMin', max: 'dataMax' });
  assert.deepEqual(getMinAndMaxFromBounds(AxisType.Value, true, 5, undefined, EchartsTimeseriesSeriesType.Bar), { scale: true, min: 5 });
  assert.equal(calculateLowerLogTick(0.042), 0.01);
});

// ------------------------------------------------------------- the spec builder ---

const ROWS = [
  { 'Orders.order_date': '2026-01', 'Orders.revenue': 100, 'Orders.order_count': 4 },
  { 'Orders.order_date': '2026-02', 'Orders.revenue': 250, 'Orders.order_count': 7 },
];

test('fromRows is the one row→spec adapter', () => {
  const spec = fromRows({ kind: 'line', rows: ROWS, categoryKey: 'Orders.order_date', valueKeys: ['Orders.revenue'] });
  assert.deepEqual(spec.categories, ['2026-01', '2026-02']);
  assert.deepEqual(spec.series, [{ name: 'Orders.revenue', values: [100, 250] }]);
});

test('fromRows with no category key yields one empty category (a single aggregate bar)', () => {
  const spec = fromRows({ kind: 'bar', rows: [{ 'Orders.revenue': 9 }], valueKeys: ['Orders.revenue'] });
  assert.deepEqual(spec.categories, ['']);
  assert.deepEqual(spec.series[0].values, [9]);
});

test('a line option is built by the vendored transformer and labels series by leaf', () => {
  const spec = fromRows({ kind: 'line', rows: ROWS, categoryKey: 'Orders.order_date', valueKeys: ['Orders.revenue', 'Orders.order_count'] });
  const option = buildChartOption(spec, COLORS) as Record<string, any>;
  assert.equal(option.useUTC, true, 'the vendored transformProps sets useUTC — this proves the slice is in the path');
  // The DECLARED measure order survives (upstream would have sorted it reverse-alphabetically).
  assert.deepEqual(option.series.map((s: any) => s.name), ['revenue', 'order_count']);
  assert.equal(option.series[0].type, 'line');
  assert.equal(option.series[0].smooth, true);
  assert.equal(option.xAxis.type, 'category');
  assert.equal(option.yAxis.type, 'value');
  assert.ok(option.legend, 'two measures get a legend');
  assert.equal(option.color[0], COLORS.teal);
});

test('a bar option rotates many categories and draws bars, with no legend for one measure', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ r: `region-${i}`, v: i }));
  const option = buildChartOption(fromRows({ kind: 'bar', rows, categoryKey: 'r', valueKeys: ['v'] }), COLORS) as Record<string, any>;
  assert.equal(option.series[0].type, 'bar');
  assert.equal(option.xAxis.axisLabel.rotate, 30);
  assert.equal(option.legend, undefined, 'one measure needs no legend');
});

test('an area option carries the vendored areaStyle opacity', () => {
  const option = buildChartOption(fromRows({ kind: 'area', rows: ROWS, categoryKey: 'Orders.order_date', valueKeys: ['Orders.revenue'] }), COLORS) as Record<string, any>;
  assert.ok(option.series[0].areaStyle, 'an area chart must have an areaStyle');
  assert.equal(option.series[0].areaStyle.opacity, 0.14);
});

test('a pie option names its slices and borders them with the panel colour', () => {
  const option = buildChartOption(fromRows({ kind: 'pie', rows: [{ r: 'DE', v: 3 }, { r: 'FR', v: 1 }], categoryKey: 'r', valueKeys: ['v'] }), COLORS) as Record<string, any>;
  assert.equal(option.series[0].type, 'pie');
  assert.deepEqual(option.series[0].data, [{ name: 'DE', value: 3 }, { name: 'FR', value: 1 }]);
  assert.equal(option.series[0].itemStyle.borderColor, COLORS.panel);
});

test('a spec with nothing to draw returns null rather than an empty axis', () => {
  assert.equal(buildChartOption({ kind: 'line', categories: ['a'], series: [] }, COLORS), null);
  assert.equal(buildChartOption({ kind: 'pie', categories: [], series: [{ name: 'v', values: [] }] }, COLORS), null);
});

test('D-R1.2 — two hosts with the same rows and keys produce the IDENTICAL option', () => {
  // Host A: a dashboards-style panel, which maps its `Panel` onto `fromRows`.
  const hostA: ChartSpec = fromRows({
    kind: 'line',
    rows: ROWS,
    categoryKey: 'Orders.order_date',
    valueKeys: ['Orders.revenue'],
    height: 320,
  });
  // Host B: any other surface (a query result, an app chart) that maps its own shape the same way.
  const hostB: ChartSpec = {
    kind: 'line',
    categories: ['2026-01', '2026-02'],
    series: [{ name: 'Orders.revenue', values: [100, 250] }],
    height: 320,
  };
  assert.deepEqual(hostA, hostB, 'the two hosts must agree on the spec');
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildChartOption(hostA, COLORS))),
    JSON.parse(JSON.stringify(buildChartOption(hostB, COLORS))),
    'the same spec must render byte-identically in both hosts',
  );
});

test('the responsive y-axis follows the chart height (upstream three tiers)', () => {
  const spec = (height: number): ChartSpec => fromRows({ kind: 'line', rows: ROWS, categoryKey: 'Orders.order_date', valueKeys: ['Orders.revenue'], height });
  const tall = buildChartOption(spec(400), COLORS) as Record<string, any>;
  const small = buildChartOption(spec(80), COLORS) as Record<string, any>;
  const micro = buildChartOption(spec(50), COLORS) as Record<string, any>;
  assert.equal(tall.yAxis.splitNumber, 5);
  assert.equal(small.yAxis.splitNumber, 1);
  assert.equal(small.yAxis.axisTick.show, false);
  assert.equal(micro.yAxis.splitNumber, undefined);
  assert.equal(micro.yAxis.axisLabel.show, false);
});
