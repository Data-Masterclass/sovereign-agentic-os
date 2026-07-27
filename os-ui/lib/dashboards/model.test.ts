/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Panel, buildPanelCubeQuery, fromTiles, fromAgent, missingPanelMembers, normalizePanel,
  panelMetrics, panelRequestedMembers, sameDashboard, viewFor,
} from './model.ts';
import { goldSales } from '../metrics/fixtures.ts';

const charts: Panel[] = [
  { name: 'Revenue', vizType: 'big_number_total', metric: 'Sales.revenue' },
  { name: 'Revenue by region', vizType: 'bar', metric: 'Sales.revenue', dimensions: ['Sales.region'] },
];

test('dual-mode: drag-drop and the agent converge on the SAME dashboard', () => {
  const view = viewFor(goldSales());
  const dragged = fromTiles('Sales Overview', view, charts);
  const agentBuilt = fromAgent({ name: 'Sales Overview', view, charts: [...charts].reverse() });
  assert.ok(sameDashboard(dragged, agentBuilt), 'both modes produce one dashboard');
});

test('charts are deduped so the two modes cannot double-add a tile', () => {
  const view = viewFor(goldSales());
  const spec = fromTiles('S', view, [charts[0], charts[0], charts[1]]);
  assert.equal(spec.charts.length, 2);
});

test('domain does not change dashboard identity (view belongs to one domain)', () => {
  const view = viewFor(goldSales());
  const withDomain = fromTiles('Sales Overview', view, charts, 'sales');
  const without = fromTiles('Sales Overview', view, charts);
  assert.ok(sameDashboard(withDomain, without));
  assert.equal(withDomain.domain, 'sales');
});

test('legacy coercion: a `{metric}` panel normalizes to `{metrics:[metric]}` (back-compat)', () => {
  const legacy: Panel = { name: 'Revenue', vizType: 'big_number', metric: 'Sales.revenue' };
  const norm = normalizePanel(legacy);
  assert.deepEqual(norm.metrics, ['Sales.revenue']);
  assert.equal(norm.metric, undefined, 'the alias is dropped after coercion');
  // A seeded/legacy spec still lands as a normal spec through fromTiles.
  const view = viewFor(goldSales());
  const spec = fromTiles('Seeded', view, [legacy]);
  assert.deepEqual(spec.charts[0].metrics, ['Sales.revenue']);
  assert.equal(spec.charts[0].metric, undefined);
});

test('panelMetrics prefers `metrics`, falls back to the `metric` alias', () => {
  assert.deepEqual(panelMetrics({ name: 'a', vizType: 'line', metrics: ['A.x', 'A.y'] }), ['A.x', 'A.y']);
  assert.deepEqual(panelMetrics({ name: 'a', vizType: 'line', metric: 'A.x' }), ['A.x']);
});

test('dedupe keys on vizType+metrics — same members different viz are distinct tiles', () => {
  const view = viewFor(goldSales());
  const spec = fromTiles('S', view, [
    { name: 'KPI', vizType: 'big_number', metrics: ['Sales.revenue'] },
    { name: 'Trend', vizType: 'line', metrics: ['Sales.revenue'] },
    { name: 'KPI dup', vizType: 'big_number', metric: 'Sales.revenue' }, // legacy alias → same key as first
  ]);
  assert.equal(spec.charts.length, 2, 'the legacy-alias duplicate is deduped away');
});

test('buildPanelCubeQuery maps a time-series panel to measures + timeDimensions + filters', () => {
  const q = buildPanelCubeQuery({
    name: 'Revenue over time',
    vizType: 'area',
    metrics: ['Sales.revenue'],
    timeDimension: 'Sales.order_date',
    timeGrain: 'month',
    filters: [{ member: 'Sales.region', operator: 'equals', values: ['DE'] }],
  });
  assert.deepEqual(q.measures, ['Sales.revenue']);
  assert.deepEqual(q.timeDimensions, [{ dimension: 'Sales.order_date', granularity: 'month' }]);
  assert.deepEqual(q.filters, [{ member: 'Sales.region', operator: 'equals', values: ['DE'] }]);
});

test('buildPanelCubeQuery folds the legacy `metric` alias into measures', () => {
  const q = buildPanelCubeQuery({ name: 'KPI', vizType: 'big_number', metric: 'Sales.revenue' });
  assert.deepEqual(q.measures, ['Sales.revenue']);
  assert.equal(q.dimensions, undefined);
});

// ── Northpeak fix: the missing-member guard (never a silent de-dimension) ──────

const servedFull = {
  measures: ['Sales.revenue'],
  dimensions: ['Sales.region', 'Sales.partner_name'],
  timeDimensions: ['Sales.order_date'],
};

test('panelRequestedMembers: measures + group-by dimensions + time dimension', () => {
  const p: Panel = {
    name: 'By partner', vizType: 'bar', metrics: ['Sales.revenue'],
    dimensions: ['Sales.partner_name'], timeDimension: 'Sales.order_date',
  };
  assert.deepEqual(panelRequestedMembers(p), ['Sales.revenue', 'Sales.partner_name', 'Sales.order_date']);
});

test('missingPanelMembers: empty when the served model exposes every requested member', () => {
  const p: Panel = { name: 'By partner', vizType: 'bar', metrics: ['Sales.revenue'], dimensions: ['Sales.partner_name'] };
  assert.deepEqual(missingPanelMembers(p, servedFull), []);
});

test('missingPanelMembers: a group-by the served model lacks is REPORTED (the single-bar bug)', () => {
  const p: Panel = { name: 'By center', vizType: 'bar', metrics: ['Sales.revenue'], dimensions: ['Sales.service_center_id'] };
  assert.deepEqual(missingPanelMembers(p, servedFull), ['Sales.service_center_id']);
});

test('missingPanelMembers: an entirely unserved view reports EVERY requested member', () => {
  const p: Panel = { name: 'By brand', vizType: 'bar', metrics: ['Cases.avg_interactions'], dimensions: ['Cases.brand'] };
  assert.deepEqual(
    missingPanelMembers(p, { measures: [], dimensions: [], timeDimensions: [] }),
    ['Cases.avg_interactions', 'Cases.brand'],
  );
});
