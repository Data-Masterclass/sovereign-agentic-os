/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter } from '../../metrics/build/adapter.ts';
import { type DashboardBuildContext, makeDashboardAdapters } from './live.ts';
import { makeMockDashboardAdapters, newDashboardMock, mockDashboardDeps } from './mocks.ts';
import { fromTiles, viewFor } from '../model.ts';
import { alertOn } from '../../metrics/alerts.ts';
import { guestTokenRequest } from '../embed.ts';
import { measureFromForm } from '../../metrics/model.ts';
import { claimsFromUser, delegate } from '../../data/identity.ts';
import { goldSales } from '../../metrics/fixtures.ts';

function ctx(over: Partial<DashboardBuildContext> = {}): DashboardBuildContext {
  const d = goldSales();
  const view = viewFor(d);
  const spec = fromTiles('Sales Overview', view, [{ name: 'Revenue', vizType: 'big_number_total', metric: 'Sales.revenue' }]);
  const token = delegate(claimsFromUser({ id: 'amir', domains: ['sales'], role: 'builder', attributes: { region: 'DE' } }), 'domain');
  return {
    spec,
    guestToken: guestTokenRequest(token, 'dash-uuid'),
    report: { cadence: 'weekly', channel: 'email' },
    alert: alertOn(d, measureFromForm({ name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] }), { id: 'a1', comparator: 'lt', threshold: 50000, notify: ['email'] }),
    state: {},
    ...over,
  };
}

test('superset adapter: ✓ only after a real import + the dashboard loads', async () => {
  const adapters = makeMockDashboardAdapters(newDashboardMock());
  const row = await runAdapter(adapters.superset, ctx());
  assert.equal(row.status, 'ok', row.error);
});

test('embed adapter: R3 — verify requires the viewer\'s RLS in the token request', async () => {
  const adapters = makeMockDashboardAdapters(newDashboardMock());
  const good = await runAdapter(adapters.embed, ctx());
  assert.equal(good.status, 'ok', good.error);
  assert.match(good.detail, /region = 'DE'/);

  // An empty-RLS token must fail verify — RLS would collapse.
  const c = ctx();
  const bad = await runAdapter(adapters.embed, { ...c, guestToken: { ...c.guestToken, rls: [] } });
  assert.equal(bad.status, 'fail');
  assert.match(bad.error ?? '', /RLS would collapse/);
});

test('report + alert adapters create and verify their artifacts', async () => {
  const adapters = makeMockDashboardAdapters(newDashboardMock());
  const c = ctx();
  const r = await runAdapter(adapters.report, c);
  const a = await runAdapter(adapters.alert, c);
  assert.equal(r.status, 'ok', r.error);
  assert.equal(a.status, 'ok', a.error);
  assert.ok(c.state.reportId && c.state.alertId);
});

test('report/alert are no-ops (still ✓) when not requested', async () => {
  const adapters = makeMockDashboardAdapters(newDashboardMock());
  const c = ctx({ report: undefined, alert: undefined });
  assert.equal((await runAdapter(adapters.report, c)).status, 'ok');
  assert.equal((await runAdapter(adapters.alert, c)).status, 'ok');
});

test('P0-1: superset adapter passes cubeSql opts from context into the bundle', async () => {
  // Capture the bundle the adapter passes to importBundle so we can assert the host/port.
  let capturedBundle = '';
  // Use a custom SupersetClient that captures the bundle, then wrap it via makeDashboardAdapters.
  const capturingClient = {
    async importBundle(_name: string, bundle: string) { capturedBundle = bundle; },
    async dashboardExists() { return true; },
    async deleteDashboard() { return false; },
    async createReport() { return 'r1'; },
    async reportExists() { return true; },
    async createAlert() { return 'a1'; },
    async alertExists() { return true; },
  };
  const mockB = newDashboardMock();
  const deps = { superset: capturingClient, embed: mockDashboardDeps(mockB).embed };
  const adapters = makeDashboardAdapters(deps);
  const d = goldSales();
  const view = viewFor(d);
  const spec = fromTiles('Sales Overview', view, [{ name: 'Revenue', vizType: 'big_number_total', metric: 'Sales.revenue' }], 'sales');
  const token = delegate(claimsFromUser({ id: 'amir', domains: ['sales'], role: 'builder', attributes: { region: 'DE' } }), 'domain');
  const c: DashboardBuildContext = {
    spec,
    guestToken: guestTokenRequest(token, 'dash-uuid'),
    state: {},
    cubeSql: { host: 'custom-cube.internal', port: 9876 },
  };
  await runAdapter(adapters.superset, c);
  // The domain-scoped bundle must carry the operator-configured host:port.
  assert.ok(capturedBundle.includes('custom-cube.internal'), 'bundle must carry configured host');
  assert.ok(capturedBundle.includes('9876'), 'bundle must carry configured port');
});
