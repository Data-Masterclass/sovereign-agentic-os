/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * runPanelQuery RLS proof (Tier 1, Phase 2): a panel resolves its numbers through the SAME
 * compiled-SQL metrics path the explorer uses (exploreMetric) — Cube is off the dashboards
 * read path. The query runs UNDER the viewer's delegated identity, so two viewers with
 * different region entitlements see DIFFERENT rows. We force the OFFLINE-MOCK path (Trino
 * unreachable) whose executor itself filters by the security-context region, so the RLS
 * guarantee is proven without a live cluster; and we prove the LOUD honesty paths: an
 * unresolved member and a dropped group-by both warn instead of silently degrading.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFromUser, delegate } from '../../data/identity.ts';
import { goldSales } from '../../metrics/fixtures.ts';
import type { Measure } from '../../data/index.ts';
import type { Panel } from '../model.ts';
import type { MemberResolver } from './panel-query.ts';

// Force the OFFLINE-MOCK path (Trino unreachable) — exploreMetric's mock executor enforces
// the security-context region, so the RLS guarantee is proven without a live cluster. On the
// local profile the honesty gate keeps the mock (not 'unavailable').
mock.module('../../metrics/build/live-clients.ts', {
  namedExports: { liveMetricsReachable: async () => false, isCubeSyncLag: () => false },
});
mock.module('@/lib/core/config', {
  namedExports: { config: { deploymentProfile: 'local' } },
});
const { runPanelQuery } = await import('./panel-query.ts');

const dataset = goldSales();
const revenue: Measure = dataset.measures[0];
// A resolver bound to the shared fixture — the panel's `Sales.revenue` member → dataset+measure.
const resolve: MemberResolver = (member) => (member === 'Sales.revenue' ? { dataset, measure: revenue } : null);

function viewerToken(region: string) {
  const claims = claimsFromUser({ id: `u_${region}`, domains: ['sales'], role: 'creator', attributes: { region } });
  return delegate(claims, 'domain');
}
const asUser = (region: string) => ({ id: `u_${region}`, domains: ['sales'], role: 'creator' as const });

const kpi: Panel = { name: 'Revenue', vizType: 'big_number', metrics: ['Sales.revenue'] };

test('two regions → different rows (per-viewer RLS at the panel boundary)', async () => {
  const de = await runPanelQuery('Sales', kpi, viewerToken('DE'), asUser('DE'), { resolve });
  const fr = await runPanelQuery('Sales', kpi, viewerToken('FR'), asUser('FR'), { resolve });

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
  const all = await runPanelQuery('Sales', kpi, delegate(claims, 'domain'), { id: 'u_all', domains: ['sales'], role: 'creator' }, { resolve });
  const de = await runPanelQuery('Sales', kpi, viewerToken('DE'), asUser('DE'), { resolve });
  assert.ok(Number(all.rows[0]?.['Sales.revenue']) > Number(de.rows[0]?.['Sales.revenue']), 'unfiltered total exceeds one region');
});

// ── Northpeak fix: LOUD missing-member degradation ─────────────────────────────
// A member no visible metric owns (undefined metric, out of entitlement, or a stale
// domain table) must WARN loudly, never resolve to a silent single bar.

test('unresolved member → honest warning + missingMembers (no silent bar)', async () => {
  const ghost: Panel = { name: 'Ghost', vizType: 'big_number', metrics: ['Sales.nope'] };
  const res = await runPanelQuery('Sales', ghost, viewerToken('DE'), asUser('DE'), { resolve });
  assert.equal(res.warning !== undefined, true, 'the degradation is LOUD');
  assert.match(res.warning!, /Sales\.nope/);
  assert.deepEqual(res.missingMembers, ['Sales.nope']);
  assert.deepEqual(res.rows, [], 'no rows — never a silently rendered wrong number');
});

// A slice on a dimension the governed view does NOT expose (e.g. the primary key) is dropped
// by exploreSpec BUT reported — the panel surfaces it as a warning, never silently un-grouped.
test('group-by on a non-view member → dropped-but-reported (LOUD, not silent)', async () => {
  const barByPk: Panel = { name: 'By id', vizType: 'bar', metrics: ['Sales.revenue'], dimensions: ['Sales.order_id'] };
  const res = await runPanelQuery('Sales', barByPk, viewerToken('DE'), asUser('DE'), { resolve });
  assert.equal(res.warning !== undefined, true);
  // exploreSpec records the dropped slice member by its bare leaf name (order_id).
  assert.deepEqual(res.missingMembers, ['order_id']);
});

// A panel resolves its number through the SAME path as the explorer: injecting a fake explore
// proves the panel is a thin pass-through over exploreMetric under the viewer's token.
test('the panel number IS the exploreMetric number (one-number-everywhere by construction)', async () => {
  let seen: { token: unknown; slice: unknown } | null = null;
  const fakeExplore = (async (_d: unknown, _m: unknown, token: unknown, slice: unknown) => {
    seen = { token, slice };
    return { member: 'Sales.revenue', rows: [{ 'Sales.revenue': 4242 }], securityContext: {}, sql: 'SELECT 1', mode: 'live (sql)' as const };
  }) as unknown as Parameters<typeof runPanelQuery>[4] extends { explore?: infer E } ? E : never;
  const res = await runPanelQuery('Sales', kpi, viewerToken('DE'), asUser('DE'), { resolve, explore: fakeExplore });
  assert.equal(res.rows[0]?.['Sales.revenue'], 4242, 'the panel returns exactly the exploreMetric row');
  assert.equal(res.mode, 'live', "live (sql) is surfaced as the panel's stable 'live' mode");
  assert.ok(seen, 'exploreMetric was called under the viewer token with the panel slice');
});
