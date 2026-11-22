/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → KPIs and Dashboards: scope, honesty, and what the upstream says.
 * USER STORY: As a creator I see my own metrics, alerts and dashboards only; a Dagster outage shows as
 *             unavailable, never as "no failures"; broken references are listed per panel.
 * ARCHITECTURE: the Dagster read is a recorder (real-container proof of the alert-run fold:
 *   core/adapters/dagster/monitoring-read.int.test.ts). The scoped lists are the tabs' own readers, injected.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
let dagsterDown = false;
const run = (id: string, status: string, tags: Record<string, string>, at: string) => ({ runId: id, status, jobName: 'j', startedAt: at, endedAt: at, tags, assetSelection: [] });
mock.module('@core/infra/dagster', {
  namedExports: {
    ...(await real('@core/infra/dagster')),
    recentOsRuns: async () => dagsterDown ? { ok: false, error: 'connect ECONNREFUSED' } : { ok: true, data: [
      run('r3', 'FAILURE', { 'os/alert': 'al_mine' }, '2026-11-21T03:00:00Z'),
      run('r2', 'SUCCESS', { 'os/alert': 'al_mine' }, '2026-11-20T03:00:00Z'),
      run('r9', 'FAILURE', { 'os/alert': 'al_hr' }, '2026-11-21T03:00:00Z'),
      run('r1', 'SUCCESS', { 'os/dataset': 'orders', 'os/domain': 'sales' }, '2026-11-19T03:00:00Z'),
    ] },
  },
});

const { registerMonitoringSources } = await import('./sources');
const { kpisView } = await import('./kpis-panel');
const { dashboardsView } = await import('./dashboards-panel');

const metric = (id: string, extra = {}) => ({ id, name: id, member: `${id}.m`, datasetId: 'orders', datasetName: 'Orders', domain: 'sales', scope: 'mine' as const, ...extra });
registerMonitoringSources({
  agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
  metrics: async (p) => (p.role === 'admin' ? [metric('revenue'), metric('broken', { error: 'model not found' }), metric('payroll', { datasetId: 'salaries', datasetName: 'Salaries', domain: 'hr' })] : [metric('revenue'), metric('broken', { error: 'model not found' })]),
  alertRules: async (p) => {
    const mine = { id: 'al_mine', member: 'revenue.m', comparator: 'lt', threshold: 100, owner: 'ada', domain: 'sales', lastEvaluated: '2026-11-21T03:00:00Z', lastBreached: true, lastValue: 80 };
    return p.role === 'admin' ? [mine, { id: 'al_hr', member: 'payroll.m', comparator: 'gt', threshold: 5, owner: 'zoe', domain: 'hr' }] : [mine];
  },
  dashboards: async (p) => {
    const d = { id: 'd1', name: 'Sales board', domain: 'sales', scope: 'mine' as const, view: 'orders', viewServed: true, panels: [{ name: 'Revenue', members: ['orders.revenue'], missing: [] }, { name: 'By region', members: ['orders.region'], missing: ['orders.region'] }] };
    return p.role === 'admin' ? [d, { id: 'd2', name: 'HR board', domain: 'hr', scope: 'domain' as const, view: 'salaries', viewServed: false, panels: [{ name: 'Pay', members: ['salaries.pay'], missing: ['salaries.pay'] }] }] : [d];
  },
});

const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const admin = { id: 'root', name: 'Root', domains: ['sales', 'hr'], allDomains: ['sales', 'hr'], activeDomain: null, role: 'admin' } as never;
beforeEach(() => { dagsterDown = false; });

test('KPIs: load errors, firing alerts and Dagster evaluation failures are what the sources say', async () => {
  const v = await kpisView(ada);
  assert.equal(v.metrics.find((m) => m.id === 'broken')!.loadError, 'model not found');
  assert.equal(v.metrics[0].id === 'broken' || v.metrics[0].alertsFiring > 0, true, 'attention first');
  const a = v.alerts[0];
  assert.equal(a.firing, true);
  assert.equal(a.condition, '< 100');
  assert.deepEqual([a.evaluations!.runs, a.evaluations!.failures, a.evaluations!.lastStatus], [2, 1, 'FAILURE']);
  assert.equal(v.metrics.find((m) => m.id === 'revenue')!.dataLastSuccessAt, '2026-11-19T03:00:00Z');
  assert.equal(v.summary!.alertsFiring, 1);
  assert.ok(v.notUpstream.some((n) => /Metric query errors/.test(n.panel)));
});

test('KPIs scope: a creator never receives another domain’s metric, alert or its Dagster run', async () => {
  const j = JSON.stringify(await kpisView(ada));
  assert.ok(!j.includes('payroll') && !j.includes('al_hr') && !j.includes('r9'), j);
  const a = await kpisView(admin);
  assert.ok(a.alerts.some((x) => x.id === 'al_hr') && a.metrics.some((m) => m.id === 'payroll'));
});

test('KPIs: Dagster down → unavailable with its reason, freshness and evaluations absent (never zero failures)', async () => {
  dagsterDown = true;
  const v = await kpisView(ada);
  assert.equal(v.sources.dagster.state, 'unavailable');
  assert.ok(v.metrics.every((m) => !('dataLastSuccessAt' in m)));
  assert.ok(v.alerts.every((a) => !('evaluations' in a)));
});

test('Dashboards: broken references are listed per panel; an unserved view is flagged; the other domain’s dashboard stays hidden', async () => {
  const v = await dashboardsView(ada);
  assert.deepEqual(v.dashboards.map((d) => d.id), ['d1']);
  assert.deepEqual(v.dashboards[0].broken, [{ panel: 'By region', missing: ['orders.region'] }]);
  assert.ok(!JSON.stringify(v).includes('salaries'));
  const a = await dashboardsView(admin);
  assert.equal(a.dashboards.find((d) => d.id === 'd2')!.viewServed, false);
  assert.equal(a.summary!.withBrokenReferences, 2);
  assert.ok(a.notUpstream.some((n) => /Query latency/.test(n.panel)), 'latency is said to be unavailable, not shown as 0');
});

test('the MCP door serves kpis and dashboards through the same functions', async () => {
  const { MONITORING_TOOLS } = await import('@core/mcp/monitoring-tools');
  const tool = MONITORING_TOOLS.find((t) => t.name === 'get_monitoring_panels')!;
  assert.equal(((await tool.call(ada, { view: 'kpis' })) as { view: string }).view, 'kpis');
  assert.equal(((await tool.call(ada, { view: 'dashboards' })) as { view: string }).view, 'dashboards');
});
