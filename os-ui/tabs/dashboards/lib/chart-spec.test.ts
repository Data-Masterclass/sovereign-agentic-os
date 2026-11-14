/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The panel → shared-chart-spec mapper (D1, D-R1.2)
 * USER STORY: As a maintainer I want the panel→chart mapping under test, because it used to live
 *             inside a `.tsx` where no test could reach it and a wrong dimension pick is invisible.
 * ARCHITECTURE: Pure. Imports no `.tsx` and no route — `lib/chart-spec.ts` and `@core/ui/charts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChartOption, fromRows } from '@core/ui/charts/spec';
import { resolveChartColors } from '@core/ui/charts/theme';
import { dimensionOf, isChartPanel, panelChartSpec } from '@tabs/dashboards/lib/chart-spec';
import type { Panel } from '@tabs/dashboards/lib/model';

const COLORS = resolveChartColors(() => undefined);

const TREND_ROWS = [
  { 'Orders.order_date': '2026-01', 'Orders.revenue': 100 },
  { 'Orders.order_date': '2026-02', 'Orders.revenue': 250 },
];

test('only chart viz types are charts; KPI and table are HTML surfaces', () => {
  for (const vizType of ['line', 'area', 'bar', 'pie'] as const) {
    assert.equal(isChartPanel({ name: 'p', vizType, metrics: ['Orders.revenue'] }), true, vizType);
  }
  for (const vizType of ['big_number', 'big_number_total', 'table'] as const) {
    assert.equal(isChartPanel({ name: 'p', vizType, metrics: ['Orders.revenue'] }), false, vizType);
    assert.equal(panelChartSpec({ name: 'p', vizType, metrics: ['Orders.revenue'] }, TREND_ROWS), null);
  }
});

test('dimensionOf finds the grouped column and nothing when there is none', () => {
  assert.equal(dimensionOf(TREND_ROWS, ['Orders.revenue']), 'Orders.order_date');
  assert.equal(dimensionOf([{ 'Orders.revenue': 1 }], ['Orders.revenue']), undefined);
});

test('a line panel charts its time dimension and marks the spec temporal', () => {
  const panel: Panel = { name: 'Revenue', vizType: 'line', metrics: ['Orders.revenue'], timeDimension: 'Orders.order_date' };
  const spec = panelChartSpec(panel, TREND_ROWS, 300);
  assert.deepEqual(spec, {
    kind: 'line',
    categories: ['2026-01', '2026-02'],
    series: [{ name: 'Orders.revenue', values: [100, 250] }],
    temporal: true,
    height: 300,
  });
});

test('a panel whose time dimension is NOT on the rows charts what the rows actually have', () => {
  // The governed query dropped the requested dimension (and said so in its warning); the chart
  // must plot the column that IS there rather than an empty axis.
  const panel: Panel = { name: 'Revenue', vizType: 'line', metrics: ['Orders.revenue'], timeDimension: 'Orders.missing' };
  const spec = panelChartSpec(panel, TREND_ROWS);
  assert.equal(spec?.categories[0], '2026-01');
  assert.equal(spec?.temporal, undefined, 'it must not claim to be a time axis it did not get');
});

test('a bar panel groups by its first dimension; a pie needs one', () => {
  const rows = [{ 'Orders.region': 'DE', 'Orders.revenue': 9 }, { 'Orders.region': 'FR', 'Orders.revenue': 3 }];
  const bar = panelChartSpec({ name: 'b', vizType: 'bar', metrics: ['Orders.revenue'], dimensions: ['Orders.region'] }, rows);
  assert.deepEqual(bar?.categories, ['DE', 'FR']);
  const pie = panelChartSpec({ name: 'p', vizType: 'pie', metrics: ['Orders.revenue'] }, rows);
  assert.deepEqual(pie?.kind, 'pie');
  assert.equal(panelChartSpec({ name: 'p', vizType: 'pie', metrics: ['Orders.revenue'] }, [{ 'Orders.revenue': 9 }]), null);
});

test('a panel with no measures has nothing to chart', () => {
  assert.equal(panelChartSpec({ name: 'p', vizType: 'bar', metrics: [] }, TREND_ROWS), null);
});

test('the legacy single-`metric` alias still charts (never a blank panel on an old spec)', () => {
  const spec = panelChartSpec({ name: 'p', vizType: 'bar', metrics: [], metric: 'Orders.revenue' }, TREND_ROWS);
  assert.deepEqual(spec?.series, [{ name: 'Orders.revenue', values: [100, 250] }]);
});

test('D-R1.2 — a dashboards panel and a generic host produce the IDENTICAL option', () => {
  const panel: Panel = { name: 'Revenue', vizType: 'line', metrics: ['Orders.revenue'], timeDimension: 'Orders.order_date' };
  const fromPanel = panelChartSpec(panel, TREND_ROWS, 240)!;
  const fromHost = fromRows({
    kind: 'line',
    rows: TREND_ROWS,
    categoryKey: 'Orders.order_date',
    valueKeys: ['Orders.revenue'],
    temporal: true,
    height: 240,
  });
  assert.deepEqual(fromPanel, fromHost);
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildChartOption(fromPanel, COLORS))),
    JSON.parse(JSON.stringify(buildChartOption(fromHost, COLORS))),
  );
});
