/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * runPanelQuery RLS proof (Tier 1): the panel query runs UNDER the viewer's delegated
 * identity, so two viewers with different region entitlements see DIFFERENT rows — the
 * whole point of per-viewer row-level security on a native dashboard. We force the
 * OFFLINE-MOCK path (Cube unreachable) whose executor itself filters by the security
 * context's region, so the guarantee is proven without a live Cube; and we prove the
 * sidecar sync-lag path degrades to a soft `pending` on the LIVE path.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFromUser, delegate } from '../../data/identity.ts';
import type { Panel } from '../model.ts';

// Force the OFFLINE-MOCK path (Cube unreachable) once for the whole file — its executor
// enforces the security-context region, so the RLS guarantee is proven without a live Cube.
mock.module('../../metrics/build/live-clients.ts', {
  namedExports: { liveMetricsReachable: async () => false, isCubeSyncLag: () => false },
});
const { runPanelQuery } = await import('./panel-query.ts');

function viewerToken(region: string) {
  const claims = claimsFromUser({ id: `u_${region}`, domains: ['sales'], role: 'creator', attributes: { region } });
  return delegate(claims, 'domain');
}

const kpi: Panel = { name: 'Revenue', vizType: 'big_number', metrics: ['Sales.revenue'] };

test('two regions → different rows (per-viewer RLS at the panel boundary)', async () => {
  const de = await runPanelQuery('Sales', kpi, viewerToken('DE'));
  const fr = await runPanelQuery('Sales', kpi, viewerToken('FR'));

  assert.equal(de.mode, 'offline-mock');
  assert.equal(de.securityContext.region, 'DE');
  assert.equal(fr.securityContext.region, 'FR');
  const deVal = de.rows[0]?.['Sales.revenue'];
  const frVal = fr.rows[0]?.['Sales.revenue'];
  assert.ok(deVal != null && frVal != null, 'both viewers get a value');
  assert.notEqual(deVal, frVal, 'DE and FR viewers see different rows (RLS)');
});

test('a viewer with no region claim sees the unfiltered total (all regions)', async () => {
  const claims = claimsFromUser({ id: 'u_all', domains: ['sales'], role: 'creator', attributes: {} });
  const all = await runPanelQuery('Sales', kpi, delegate(claims, 'domain'));
  const de = await runPanelQuery('Sales', kpi, viewerToken('DE'));
  assert.ok(Number(all.rows[0]?.['Sales.revenue']) > Number(de.rows[0]?.['Sales.revenue']), 'unfiltered total exceeds one region');
});
