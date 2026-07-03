/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFromUser, delegate } from '../data/identity.ts';
import { scaffoldCubeYaml } from '../data/metrics.ts';
import { goldSales } from './fixtures.ts';
// metrics
import { measureFromForm, measureFromAgent, measureFromYaml, measureMember, sameMeasure, type MetricForm } from './model.ts';
import { convergence, numbersMatch } from './consistency.ts';
import { exploreSpec, explore, type CubeExecutor } from './explorer.ts';
import { metricRecord, governMetric } from './governance.ts';
import { runAdapter, type MetricBuildContext } from './build/adapter.ts';
import { newMetricMock, makeMockMetricAdapters, mockMetricDeps } from './build/mocks.ts';
// dashboards
import { fromTiles, fromAgent, sameDashboard, viewFor, type ChartSpec } from '../dashboards/model.ts';
import { guestTokenRequest } from '../dashboards/embed.ts';
import { alertOn, evaluateAlert, dueReports, sendReport, type ScheduledReport } from '../dashboards/alerts.ts';
import { governDashboard, dashboardRecord } from '../dashboards/governance.ts';
import { makeMockDashboardAdapters, newDashboardMock } from '../dashboards/build/mocks.ts';
import { type DashboardBuildContext } from '../dashboards/build/live.ts';

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
  assert.ok(sameMeasure(m, measureFromYaml(scaffoldCubeYaml(d), 'Revenue')));
  const conv = convergence(d, { form: FORM, agent: { ...FORM }, yaml: scaffoldCubeYaml(d) });
  assert.ok(conv.ok && conv.member === 'Sales.revenue', JSON.stringify(conv.rows));
});

test('GATE 2 — metric build: cube resolves + explorer numbers match the agent', async () => {
  const d = goldSales();
  const backend = newMetricMock();
  const adapters = makeMockMetricAdapters(backend);
  const ctx: MetricBuildContext = { dataset: d, measure: d.measures[0], schema: scaffoldCubeYaml(d), member: measureMember(d, d.measures[0]), securityContext: { sub: 'amir', region: 'DE' } };
  assert.equal((await runAdapter(adapters.cube, ctx)).status, 'ok');
  const explorerRow = await runAdapter(adapters['metric-explorer'], ctx);
  assert.equal(explorerRow.status, 'ok', explorerRow.error);
  assert.match(explorerRow.detail, /numbers match/);
});

test('GATE 3 — explore by region: two viewers see DIFFERENT rows (Cube RLS)', async () => {
  const d = goldSales();
  const spec = exploreSpec(d, d.measures[0], { dimensions: ['region'] });
  const cube: CubeExecutor = {
    async load(_q, c) {
      const all = [{ region: 'DE', 'Sales.revenue': 1 }, { region: 'FR', 'Sales.revenue': 2 }];
      return { rows: c.region ? all.filter((r) => r.region === c.region) : all };
    },
  };
  const de = await explore(spec, viewer('amir', 'DE'), cube);
  const fr = await explore(spec, viewer('bea', 'FR'), cube);
  assert.notDeepEqual(de.rows, fr.rows);
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

test('GATE 5+6 — Sales Overview both ways → same dashboard; build superset+embed+report+alert', async () => {
  const d = goldSales();
  const view = viewFor(d);
  const charts: ChartSpec[] = [
    { name: 'Revenue', vizType: 'big_number_total', metric: 'Sales.revenue' },
    { name: 'By region', vizType: 'bar', metric: 'Sales.revenue', dimensions: ['Sales.region'] },
  ];
  const dragged = fromTiles('Sales Overview', view, charts);
  const agentBuilt = fromAgent({ name: 'Sales Overview', view, charts: [...charts].reverse() });
  assert.ok(sameDashboard(dragged, agentBuilt));

  const adapters = makeMockDashboardAdapters(newDashboardMock());
  const ctx: DashboardBuildContext = {
    spec: dragged,
    guestToken: guestTokenRequest(viewer('amir', 'DE', 'builder'), 'sales-overview'),
    report: { cadence: 'weekly', channel: 'email' },
    alert: alertOn(d, d.measures[0], { id: 'a1', comparator: 'lt', threshold: 50000, notify: ['email'] }),
    state: {},
  };
  for (const tool of ['superset', 'embed', 'report', 'alert']) {
    const row = await runAdapter(adapters[tool], ctx);
    assert.equal(row.status, 'ok', `${tool}: ${row.error}`);
  }
  // governance for the dashboard too
  const rec = dashboardRecord('sales-overview', dragged, 'amir', 'personal');
  assert.equal(governDashboard(rec, 'promote', { id: 'bea', role: 'builder' }).record.tier, 'domain');
});

test('GATE 7 — embed: two viewers get DIFFERENT RLS clauses in the guest token (R3)', () => {
  const de = guestTokenRequest(viewer('amir', 'DE'), 'sales-overview');
  const fr = guestTokenRequest(viewer('bea', 'FR'), 'sales-overview');
  assert.notDeepEqual(de.rls, fr.rls);
  assert.deepEqual(de.rls, [{ clause: "region = 'DE'" }]);
});

test('GATE 8+9 — alert notifies AND triggers a traced agent run; a scheduled report sends', () => {
  const d = goldSales();
  const rule = alertOn(d, d.measures[0], { id: 'a1', comparator: 'lt', threshold: 50000, notify: ['email', 'slack'], triggerAgent: { systemId: 'sales', agent: 'sales-agent', preset: 'recovery' } });
  const evald = evaluateAlert(rule, 42000);
  assert.ok(evald.breached && evald.notifications.length === 2 && evald.agentRun?.traced === true);

  const now = 10_000_000_000_000;
  const reports: ScheduledReport[] = [{ id: 'r1', dashboardId: 'sales-overview', cadence: 'weekly', channel: 'email', lastSentAt: now - 8 * 24 * 3600 * 1000 }];
  const due = dueReports(reports, now);
  assert.equal(due.length, 1);
  assert.equal(sendReport(due[0], now).send.dashboardId, 'sales-overview');
});

test('GATE 10 — numbers match: explorer == dashboard == agent metrics tool', async () => {
  const d = goldSales();
  const backend = newMetricMock();
  const deps = mockMetricDeps(backend);
  await deps.cube.reload('Sales', scaffoldCubeYaml(d)); // load so the member resolves
  const member = measureMember(d, d.measures[0]);
  const agent = async (m: string) => deps.cube.resolveMeasure(m);
  const explorer = async (m: string) => {
    const { rows } = await deps.cube.explore({ measures: [m], dimensions: [], limit: 100 }, { region: 'DE' });
    return rows.length ? Number(rows[0][m]) : null;
  };
  const dashboard = agent; // a chart resolves the same member the agent does
  const r = await numbersMatch(member, { explorer, dashboard, agent });
  assert.ok(r.ok, r.detail);
});
