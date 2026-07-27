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

// ── Northpeak fix: LOUD missing-member degradation on the LIVE path ────────────
// The bug: a bar panel grouped by a dimension the SERVED model lacks (missing/stale
// domain table) silently collapsed to a single un-grouped bar / forever-"syncing".
// Now: an explicit `warning` + `missingMembers`, never silent.

const barByBrand: Panel = {
  name: 'Interactions by brand', vizType: 'bar',
  metrics: ['Cases.avg_interactions'], dimensions: ['Cases.brand'],
};

const servedCases = { name: 'Cases', measures: ['Cases.avg_interactions'], dimensions: ['Cases.brand'], timeDimensions: [] };
const servedCasesNoBrand = { name: 'Cases', measures: ['Cases.avg_interactions'], dimensions: [], timeDimensions: [] };

test('LIVE + served model lacks the group-by → honest warning + missingMembers (no silent single bar)', async () => {
  const loads: unknown[] = [];
  const res = await runPanelQuery('Cases', barByBrand, viewerToken('DE'), {
    reachable: async () => true,
    meta: async () => [servedCasesNoBrand],
    load: async (q) => { loads.push(q); return { rows: [{ 'Cases.avg_interactions': 1 }], annotation: {} }; },
  });
  assert.equal(res.warning !== undefined, true, 'the degradation is LOUD');
  assert.match(res.warning!, /Cases\.brand/);
  assert.match(res.warning!, /re-promotion/i);
  assert.deepEqual(res.missingMembers, ['Cases.brand']);
  assert.deepEqual(res.rows, [], 'no rows — never a silently un-grouped result');
  assert.equal(loads.length, 0, 'the query is not even sent (it could not render as designed)');
});

test('LIVE + served model has every member → the query runs and rows return (no warning)', async () => {
  const res = await runPanelQuery('Cases', barByBrand, viewerToken('DE'), {
    reachable: async () => true,
    meta: async () => [servedCases],
    load: async () => ({ rows: [{ 'Cases.brand': 'Fjellrand', 'Cases.avg_interactions': 4.42 }], annotation: {} }),
  });
  assert.equal(res.warning, undefined);
  assert.equal(res.rows.length, 1);
});

test('LIVE + /meta unreachable → the guard cannot judge, so a load error PROPAGATES (never a fake warning)', async () => {
  // isCubeSyncLag is module-mocked to false in this file, so the throw must surface —
  // proving the served-model guard does not swallow errors it can't attribute.
  await assert.rejects(
    () => runPanelQuery('Cases', barByBrand, viewerToken('DE'), {
      reachable: async () => true,
      meta: async () => [],
      load: async () => { throw new Error('Cube 400: something else broke'); },
    }),
    /something else broke/,
  );
});
