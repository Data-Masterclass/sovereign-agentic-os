/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → KPIs and Dashboards never read an unloaded store as "nothing there"
 * USER STORY: As an operator I must not see "no alerts" or "no dashboards" while the store behind them could not be
 *             read from OpenSearch; I see the source as unavailable, with the reason.
 * ARCHITECTURE: the REAL alert-rule and dashboards stores over the REAL os-mirror; only the HTTP edge to OpenSearch is
 *   a stub (reachable and empty, or no answer at all → the mirror's own null read). Lives at the os-ui root because a
 *   tab test may not import another tab. Also pins the production scope filter of the alert-rule source.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let reachable = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (!/9200|opensearch/i.test(url)) return realFetch(input);
  if (!reachable) throw new Error('connect ECONNREFUSED');
  const body = /_search/.test(url) ? { took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, hits: [] } } : { acknowledged: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const alertStore = await import('@tabs/metrics/lib/alert-store');
const dashStore = await import('@tabs/dashboards/lib/store');
const { monitoringAlertRulesSource, monitoringDashboardsSource } = await import('./monitoring-sources');
const { registerMonitoringSources } = await import('@tabs/monitoring/lib/panels/sources');
const { monitoringSourcesImpl } = await import('./monitoring-sources');
const { kpisView } = await import('@tabs/monitoring/lib/panels/kpis-panel');
const { dashboardsView } = await import('@tabs/monitoring/lib/panels/dashboards-panel');

const user = (id: string, role: string, domains: string[]) => ({ id, name: id, domains, allDomains: domains, activeDomain: null, role }) as never;
const rule = (id: string) => ({ id, member: `${id}.m`, comparator: 'gt', threshold: 1, notify: ['in_app'] }) as never;

beforeEach(() => {
  reachable = true;
  alertStore.__resetAlertStore();
  dashStore.__resetDashboards();
  registerMonitoringSources(monitoringSourcesImpl);
});

test('alerts twin: OpenSearch answers with an empty index → the source is live and says "no rules"', async () => {
  const v = await kpisView(user('ada', 'creator', ['sales']));
  assert.equal(v.sources.alerts.state, 'live');
  assert.deepEqual(v.alerts, []);
});

test('alerts: the mirror read is null (OpenSearch unreachable) → unavailable with a reason, never "no alerts" while live', async () => {
  reachable = false;
  const v = await kpisView(user('ada', 'creator', ['sales']));
  assert.equal(v.sources.alerts.state, 'unavailable');
  assert.match(JSON.stringify(v.sources.alerts), /not loaded|could not be read/i);
  assert.equal(v.summary, null, 'no summary is claimed from an unloaded store');
  assert.equal(alertStore.alertStoreHydrationState(), 'failed');
});

test('alerts: a failed hydration is retried by the next read, and a later success is live', async () => {
  reachable = false;
  await assert.rejects(monitoringAlertRulesSource({ id: 'ada', domains: ['sales'], role: 'creator' }));
  reachable = true;
  assert.deepEqual(await monitoringAlertRulesSource({ id: 'ada', domains: ['sales'], role: 'creator' }), []);
  assert.equal(alertStore.alertStoreHydrationState(), 'hydrated');
});

test('dashboards twin: OpenSearch answers with an empty index → live', async () => {
  const v = await dashboardsView(user('ada', 'creator', ['sales']));
  assert.equal(v.sources.inventory.state, 'live');
});

test('dashboards: the store did not hydrate (null mirror read) → unavailable with a reason, no summary', async () => {
  reachable = false;
  const v = await dashboardsView(user('ada', 'creator', ['sales']));
  assert.equal(dashStore.hydrationState(), 'failed');
  assert.equal(v.sources.inventory.state, 'unavailable');
  assert.match(JSON.stringify(v.sources.inventory), /not loaded|could not be read/i);
  assert.equal(v.summary, null);
  await assert.rejects(monitoringDashboardsSource({ id: 'ada', domains: ['sales'], role: 'creator' }));
});

test('alert scope (production filter): creator own only · builder and domain admin own + their domains · admin all', async () => {
  alertStore.saveAlertRule(rule('mine'), 'ada', 'sales');
  alertStore.saveAlertRule(rule('sales_other_owner'), 'bob', 'sales');
  alertStore.saveAlertRule(rule('hr_rule'), 'zoe', 'hr');
  const ids = async (id: string, role: string, domains: string[]) => (await monitoringAlertRulesSource({ id, domains, role })).map((r) => r.id).sort();
  assert.deepEqual(await ids('ada', 'creator', ['sales']), ['mine'], 'a creator sees only the rules they own');
  assert.deepEqual(await ids('ada', 'builder', ['sales']), ['mine', 'sales_other_owner'], 'a builder: own + their domains, not hr');
  assert.deepEqual(await ids('ada', 'domain_admin', ['sales']), ['mine', 'sales_other_owner']);
  assert.deepEqual(await ids('zoe', 'creator', ['hr']), ['hr_rule']);
  assert.deepEqual(await ids('root', 'admin', ['sales']), ['hr_rule', 'mine', 'sales_other_owner'], 'an admin sees all');
  assert.deepEqual(await ids('eve', 'builder', ['finance']), [], 'a builder with no matching domain sees nothing');
});
