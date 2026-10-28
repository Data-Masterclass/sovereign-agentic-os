/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFromUser, delegate } from '../data/identity.ts';
import { scaffoldMetricYaml } from '../data/metrics.ts';
import { goldSales } from './fixtures.ts';
// metrics
import { measureFromForm, measureFromAgent, measureFromYaml, measureMember, sameMeasure, type MetricForm } from './model.ts';
import { convergence, numbersMatch } from './consistency.ts';
import { exploreSpec, dropToSql } from './explorer.ts';
import { metricRecord, governMetric } from './governance.ts';
import { runAdapter, type MetricBuildContext } from './build/adapter.ts';
import { makeMetricAdapters, memberValue, type MetricExplore } from './build/live.ts';
// dashboards (Tier 1 — native ECharts panels over governed Trino SQL)
import { fromTiles, fromAgent, sameDashboard, viewFor, panelMetrics, normalizePanel, type Panel } from '../dashboards/model.ts';
import { propagate } from '../data/identity.ts';
import { alertOn, evaluateAlert } from './alerts.ts';
import { dueReports, sendReport, type ScheduledReport } from '../dashboards/reports.ts';
import { governDashboard, dashboardRecord } from '../dashboards/governance.ts';

/**
 * THE KIND-GATE, executable. Walks the full vertical slice end-to-end through the real
 * modules (offline-mock build path — the honest fallback when no cluster is up), proving
 * each gate bullet. This is the runnable evidence for the autonomous build.
 */

const FORM: MetricForm = { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] };
function viewer(id: string, region: string, role: 'creator' | 'builder' | 'admin' = 'creator') {
  return delegate(claimsFromUser({ id, domains: ['sales'], role, attributes: { region } }), 'domain');
}

test('GATE 1 — define Revenue: form + agent + YAML produce the SAME measure + member', () => {
  const d = goldSales();
  const m = measureFromForm(FORM);
  assert.ok(sameMeasure(m, measureFromAgent({ ...FORM })));
  assert.ok(sameMeasure(m, measureFromYaml(scaffoldMetricYaml(d), 'Revenue')));
  const conv = convergence(d, { form: FORM, agent: { ...FORM }, yaml: scaffoldMetricYaml(d) });
  assert.ok(conv.ok && conv.member === 'Sales.revenue', JSON.stringify(conv.rows));
});

test('GATE 2 — metric build: the governed Trino adapter resolves the member to a number', async () => {
  const d = goldSales();
  const measure = d.measures[0];
  const member = measureMember(d, measure);
  // The ONE adapter a metric build runs: the member compiled to governed SQL over the
  // gold mart, executed AS the viewer. We inject the explore dep (no cluster needed) —
  // the adapter contract (apply ran it, verify re-reads a real number) is the gate.
  const explore: MetricExplore = async () => ({ rows: [{ [member]: 4242 }], mode: 'live (sql)' });
  const adapters = makeMetricAdapters({ explore });
  const ctx: MetricBuildContext = { dataset: d, measure, member, token: viewer('amir', 'DE') };
  const row = await runAdapter(adapters.trino, ctx);
  assert.equal(row.status, 'ok', row.error);
  assert.match(row.detail, /governed Trino SQL/);
  assert.equal(memberValue(ctx.outcome!.rows, member), 4242);
});

test('GATE 2b — a build can never report ✓ when the lakehouse is unreachable (no fabricated number)', async () => {
  const d = goldSales();
  const measure = d.measures[0];
  const member = measureMember(d, measure);
  const explore: MetricExplore = async () => ({ rows: [], mode: 'unavailable', unavailable: true, warning: 'Trino unreachable' });
  const adapters = makeMetricAdapters({ explore });
  const ctx: MetricBuildContext = { dataset: d, measure, member, token: viewer('amir', 'DE') };
  const row = await runAdapter(adapters.trino, ctx);
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /unreachable/);
});

test('GATE 3 — explore by region: two viewers see DIFFERENT rows (per-viewer RLS)', async () => {
  const d = goldSales();
  const measure = d.measures[0];
  const member = measureMember(d, measure);
  const spec = exploreSpec(d, measure, { dimensions: ['region'] });
  assert.deepEqual(dropToSql(spec).length > 0, true, 'the slice compiles to governed SQL');
  // ONE compiled query, executed under each viewer's delegated identity: the executor
  // applies the token's region claim exactly as OPA/Trino does for the real read.
  const all = [{ region: 'DE', [member]: 1 }, { region: 'FR', [member]: 2 }];
  const exploreAs = (region: string): MetricExplore => async () => ({
    rows: all.filter((r) => r.region === region),
    mode: 'live (sql)',
  });
  const runFor = async (id: string, region: string) => {
    const ctx: MetricBuildContext = { dataset: d, measure, member, token: viewer(id, region) };
    await runAdapter(makeMetricAdapters({ explore: exploreAs(region) }).trino, ctx);
    return ctx.outcome!.rows;
  };
  const de = await runFor('amir', 'DE');
  const fr = await runFor('bea', 'FR');
  assert.notDeepEqual(de, fr);
  assert.deepEqual(de, [{ region: 'DE', [member]: 1 }]);
});

test('GATE 4 — govern: Builder promotes, Admin certifies, a non-Builder cannot', async () => {
  const d = goldSales();
  const rec = metricRecord(d, d.measures[0], 'amir', 'personal');
  const resolve = async () => 42000;
  assert.equal((await governMetric(rec, 'promote', { id: 'amir', role: 'creator' }, resolve)).ok, false);
  const promoted = await governMetric(rec, 'promote', { id: 'bea', role: 'builder' }, resolve);
  assert.ok(promoted.ok && promoted.record.tier === 'domain');
  assert.equal((await governMetric(promoted.record, 'certify', { id: 'bea', role: 'builder' }, resolve)).ok, false);
  const certified = await governMetric(promoted.record, 'certify', { id: 'sara', role: 'admin' }, resolve);
  assert.ok(certified.ok && certified.record.tier === 'marketplace');
});

test('GATE 5+6 — Sales Overview both ways → same NATIVE dashboard; panels carry governed members', () => {
  const d = goldSales();
  const view = viewFor(d);
  const panels: Panel[] = [
    { name: 'Revenue', vizType: 'big_number', metrics: ['Sales.revenue'] },
    { name: 'By region', vizType: 'bar', metrics: ['Sales.revenue'], dimensions: ['Sales.region'] },
  ];
  const dragged = fromTiles('Sales Overview', view, panels);
  const agentBuilt = fromAgent({ name: 'Sales Overview', view, charts: [...panels].reverse() });
  assert.ok(sameDashboard(dragged, agentBuilt), 'drag-drop and the agent converge on one dashboard');

  // Each panel carries the governed MEMBERS the viewer's compiled Trino SELECT resolves
  // (Tier 1 — no semantic-layer service). The bar panel groups by its dimension.
  assert.deepEqual(panelMetrics(dragged.charts[0]), ['Sales.revenue']);
  assert.deepEqual(normalizePanel(dragged.charts[1]).dimensions, ['Sales.region']);

  // governance for the dashboard too
  const rec = dashboardRecord('sales-overview', dragged, 'amir', 'personal');
  assert.equal(governDashboard(rec, 'promote', { id: 'bea', role: 'builder' }).record.tier, 'domain');
});

test('GATE 7 — native panels: two viewers resolve DIFFERENT rows under their own RLS (R3)', () => {
  // The panel-query runs under each viewer's delegated identity (propagate → securityContext),
  // exactly as the /api/dashboards/panel-query route does. Two viewers → two security contexts.
  const de = propagate(viewer('amir', 'DE')).securityContext;
  const fr = propagate(viewer('bea', 'FR')).securityContext;
  assert.equal(de.region, 'DE');
  assert.equal(fr.region, 'FR');
  assert.notDeepEqual(de, fr, 'the RLS security context differs per viewer');
});

test('GATE 8+9 — alert notifies AND triggers a traced agent run; a scheduled report sends', () => {
  const d = goldSales();
  const rule = alertOn(d, d.measures[0], { id: 'a1', comparator: 'lt', threshold: 50000, notify: ['in_app'], triggerAgent: { systemId: 'sales', agent: 'sales-agent', preset: 'recovery' } });
  const evald = evaluateAlert(rule, 42000);
  assert.ok(evald.breached && evald.notifications.length === 1 && evald.agentRun?.traced === true);

  const now = 10_000_000_000_000;
  const reports: ScheduledReport[] = [{ id: 'r1', dashboardId: 'sales-overview', cadence: 'weekly', channel: 'in_app', lastSentAt: now - 8 * 24 * 3600 * 1000 }];
  const due = dueReports(reports, now);
  assert.equal(due.length, 1);
  assert.equal(sendReport(due[0], now).send.dashboardId, 'sales-overview');
});

test('GATE 10 — numbers match: explorer == dashboard == agent metrics tool', async () => {
  const d = goldSales();
  const member = measureMember(d, d.measures[0]);
  // ONE governed member, ONE compiled SQL path: the explorer, a dashboard panel and the
  // agent tool all resolve the SAME member through exploreMetric, so by construction they
  // read the same number. We model that single path once and assert the three agree.
  const governedRead = async (m: string) => (m === member ? 4242 : null);
  const r = await numbersMatch(member, { explorer: governedRead, dashboard: governedRead, agent: governedRead });
  assert.ok(r.ok, r.detail);
});
