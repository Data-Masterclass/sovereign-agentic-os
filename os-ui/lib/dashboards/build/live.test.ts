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
  const backend = newDashboardMock();
  const adapters = makeMockDashboardAdapters(backend);
  // The embed adapter mints against the dashboard's embedded UUID, so the dashboard must
  // have been imported first (the build runs the superset adapter before embed).
  await runAdapter(adapters.superset, ctx());
  const good = await runAdapter(adapters.embed, ctx());
  assert.equal(good.status, 'ok', good.error);
  assert.match(good.detail, /region = 'DE'/);

  // An empty-RLS token must fail — RLS would collapse (the mock signer refuses to mint one).
  const c = ctx();
  const bad = await runAdapter(adapters.embed, { ...c, guestToken: { ...c.guestToken, rls: [] } });
  assert.equal(bad.status, 'fail');
  assert.match(bad.error ?? '', /RLS would collapse/);
});

test('embed adapter mints against the EMBEDDED UUID, not the OS dashboard id (guest-token 400 fix)', async () => {
  // Regression: buildDashboard minted the guest token against ctx.guestToken.resourceId,
  // which is the OS dashboard id (e.g. "dash-uuid") — Superset 400s ("EmbeddedDashboard not
  // found.") on that. The embed adapter must resolve the embedded UUID and mint against it.
  let mintedResourceId = '';
  const superset = {
    async importBundle() {},
    async dashboardExists() { return true; },
    async embeddedUuid() { return 'real-embedded-uuid'; },
    async deleteDashboard() { return false; },
    async createReport() { return 'r1'; },
    async reportExists() { return true; },
    async createAlert() { return 'a1'; },
    async alertExists() { return true; },
  };
  const embed = {
    async mint(req: { resourceId: string; ttlSeconds: number }) {
      mintedResourceId = req.resourceId;
      return { token: 'tok', expiresInSeconds: req.ttlSeconds };
    },
  };
  const adapters = makeDashboardAdapters({ superset, embed });
  const token = delegate(claimsFromUser({ id: 'amir', domains: ['sales'], role: 'builder', attributes: { region: 'DE' } }), 'domain');
  const c = ctx({ guestToken: guestTokenRequest(token, 'dash-os-id') });
  const row = await runAdapter(adapters.embed, c);
  assert.equal(row.status, 'ok', row.error);
  assert.equal(mintedResourceId, 'real-embedded-uuid'); // NOT 'dash-os-id'
});

test('embed adapter fails honestly when the dashboard is not embeddable (no false ✓)', async () => {
  const superset = {
    async importBundle() {},
    async dashboardExists() { return false; },
    async embeddedUuid() { return null; }, // not found in Superset
    async deleteDashboard() { return false; },
    async createReport() { return 'r1'; },
    async reportExists() { return true; },
    async createAlert() { return 'a1'; },
    async alertExists() { return true; },
  };
  const embed = { async mint() { throw new Error('should not be called'); } };
  const adapters = makeDashboardAdapters({ superset, embed });
  const row = await runAdapter(adapters.embed, ctx());
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /not embeddable/);
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
    async embeddedUuid() { return 'embed-uuid'; },
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
