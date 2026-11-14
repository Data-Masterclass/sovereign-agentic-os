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
import { claimsFromUser, delegate } from '@tabs/data/lib/identity';
import { goldSales } from '@tabs/metrics/lib/fixtures';
import type { Measure } from '@tabs/data/lib/index';
import type { Panel } from '@tabs/dashboards/lib/model';
import type { MemberResolver } from '@tabs/dashboards/lib/build/panel-query';

// Force the OFFLINE-MOCK path (Trino unreachable) — exploreMetric's mock executor enforces
// the security-context region, so the RLS guarantee is proven without a live cluster. On the
// local profile the honesty gate keeps the mock (not 'unavailable').
mock.module('@tabs/metrics/lib/build/live-clients', {
  namedExports: { liveMetricsReachable: async () => false },
});
mock.module('@core/kernel/config', {
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

// P1-6: a multi-measure panel runs its explores CONCURRENTLY (Promise.all) but must still
// merge per-measure results onto one row per slice key — deterministically, in member order.
test('multi-measure panel merges per-measure rows onto one row per slice (P1-6 concurrency)', async () => {
  const ds = goldSales();
  const revenue: Measure = ds.measures[0];
  // Two governed members on the same view; each explore returns its own measure keyed by slice.
  const twoResolve: MemberResolver = (member) =>
    member === 'Sales.revenue' || member === 'Sales.orders' ? { dataset: ds, measure: revenue } : null;
  // A fake explore that returns per-region rows for whichever measure it was asked for. The
  // measure member is derived from the dataset+measure pair — here we key by call order.
  const calls: string[] = [];
  const fakeExplore = (async (_d: unknown, _m: unknown, _t: unknown, _s: unknown) => {
    const member = calls.length === 0 ? 'Sales.revenue' : 'Sales.orders';
    calls.push(member);
    return {
      member,
      rows: [
        { region: 'DE', [member]: member === 'Sales.revenue' ? 100 : 5 },
        { region: 'FR', [member]: member === 'Sales.revenue' ? 200 : 9 },
      ],
      securityContext: {}, sql: `SELECT ${member}`, mode: 'live (sql)' as const,
    };
  }) as unknown as Parameters<typeof runPanelQuery>[4] extends { explore?: infer E } ? E : never;

  const panel: Panel = { name: 'Rev+Orders by region', vizType: 'bar', metrics: ['Sales.revenue', 'Sales.orders'], dimensions: ['Sales.region'] };
  const res = await runPanelQuery('Sales', panel, viewerToken('DE'), asUser('DE'), { resolve: twoResolve, explore: fakeExplore });

  assert.equal(res.rows.length, 2, 'one merged row per region (not four)');
  const de = res.rows.find((r) => r.region === 'DE')!;
  const fr = res.rows.find((r) => r.region === 'FR')!;
  assert.equal(de['Sales.revenue'], 100);
  assert.equal(de['Sales.orders'], 5, 'both measures land on the same DE row');
  assert.equal(fr['Sales.revenue'], 200);
  assert.equal(fr['Sales.orders'], 9);
  assert.match(res.sql, /Sales\.revenue/);
  assert.match(res.sql, /Sales\.orders/);
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

test('D10 — an unservable filter operator is a typed bad_request BEFORE any query runs', async () => {
  // The old code did `.filter((f) => f.operator === 'equals')` and dropped the rest unreported, so
  // a panel authored with `amount >= 1000` rendered the UNFILTERED number as though it were
  // filtered. It is now refused, and refused before the governed query is even attempted.
  const panel: Panel = {
    name: 'Big orders',
    vizType: 'bar',
    metrics: ['Sales.revenue'],
    filters: [{ member: 'Sales.amount', operator: '>=', values: ['1000'] }],
  };
  let explored = 0;
  const explore = (async (...args: unknown[]) => {
    explored += 1;
    void args;
    return { rows: [{ 'Sales.revenue': 999 }], mode: 'live' as const, sql: 'SELECT 1' };
  }) as unknown as NonNullable<Parameters<typeof runPanelQuery>[4]>['explore'];
  await assert.rejects(
    () => runPanelQuery('Sales', panel, viewerToken('DE'), asUser('DE'), { resolve, explore }),
    (e: unknown) => {
      assert.equal((e as { status?: number }).status, 400, 'a typed bad_request, never a 500');
      assert.match((e as Error).message, /cannot be served by the governed query path/);
      assert.match((e as Error).message, /Sales\.amount >=/);
      return true;
    },
  );
  assert.equal(explored, 0, 'no governed query may run for a panel that cannot be served');
});

test('D10 — a servable `in` filter still reaches the governed WHERE, and an empty one is dropped', async () => {
  const seen: { filters?: { column: string; values: string[] }[] }[] = [];
  const explore = (async (_d: unknown, _m: unknown, _t: unknown, slice: { filters?: { column: string; values: string[] }[] }) => {
    seen.push(slice);
    return { rows: [{ 'Sales.revenue': 1 }], mode: 'live' as const, sql: 'SELECT 1' };
  }) as unknown as NonNullable<Parameters<typeof runPanelQuery>[4]>['explore'];
  const panel: Panel = {
    name: 'Channels',
    vizType: 'bar',
    metrics: ['Sales.revenue'],
    filters: [
      { member: 'Sales.channel', operator: 'in', values: ['web', 'retail'] },
      { member: 'Sales.region', operator: 'equals', values: [] },
    ],
  };
  await runPanelQuery('Sales', panel, viewerToken('DE'), asUser('DE'), { resolve, explore });
  assert.deepEqual(seen[0].filters, [{ column: 'channel', values: ['web', 'retail'] }]);
});

test('H-1 — an injected time grain is REFUSED at the query door, before any SQL is built', async () => {
  // `tabs/metrics/lib/explorer.ts` interpolates the grain into `date_trunc('<grain>', "col")`, and
  // the panel arrives raw from the request body, so an unchecked cast was a live injection.
  const panel: Panel = {
    name: 'Trend',
    vizType: 'line',
    metrics: ['Sales.revenue'],
    timeDimension: 'Sales.order_date',
    timeGrain: "month'), (SELECT password FROM users) --" as never,
  };
  let explored = 0;
  const explore = (async () => {
    explored += 1;
    return { rows: [], mode: 'live' as const, sql: '' };
  }) as unknown as NonNullable<Parameters<typeof runPanelQuery>[4]>['explore'];
  await assert.rejects(
    () => runPanelQuery('Sales', panel, viewerToken('DE'), asUser('DE'), { resolve, explore }),
    (e: unknown) => {
      assert.equal((e as { status?: number }).status, 400);
      assert.match((e as Error).message, /not one the governed query path can serve/);
      return true;
    },
  );
  assert.equal(explored, 0, 'no SQL may be compiled for an unservable grain');
});

test('H-1 — every servable grain still reaches the compiler unchanged', async () => {
  const seen: (string | undefined)[] = [];
  const explore = (async (_d: unknown, _m: unknown, _t: unknown, slice: { granularity?: string }) => {
    seen.push(slice.granularity);
    return { rows: [], mode: 'live' as const, sql: '' };
  }) as unknown as NonNullable<Parameters<typeof runPanelQuery>[4]>['explore'];
  for (const grain of ['day', 'week', 'month', 'quarter', 'year'] as const) {
    await runPanelQuery(
      'Sales',
      { name: 'T', vizType: 'line', metrics: ['Sales.revenue'], timeDimension: 'Sales.order_date', timeGrain: grain },
      viewerToken('DE'),
      asUser('DE'),
      { resolve, explore },
    );
  }
  assert.deepEqual(seen, ['day', 'week', 'month', 'quarter', 'year']);
});

test('M-9 — a filter value carrying a SQL comment marker is NAMED, not silently stripped', async () => {
  const seen: { filters?: { column: string; values: string[] }[] }[] = [];
  const explore = (async (_d: unknown, _m: unknown, _t: unknown, slice: { filters?: { column: string; values: string[] }[] }) => {
    seen.push(slice);
    return { rows: [{ 'Sales.revenue': 1 }], mode: 'live' as const, sql: 'SELECT 1' };
  }) as unknown as NonNullable<Parameters<typeof runPanelQuery>[4]>['explore'];
  const res = await runPanelQuery(
    'Sales',
    { name: 'F', vizType: 'bar', metrics: ['Sales.revenue'], filters: [{ member: 'Sales.region', operator: 'equals', values: ['DE-- drop'] }] },
    viewerToken('DE'),
    asUser('DE'),
    { resolve, explore },
  );
  assert.match(res.warning ?? '', /SQL comment marker/);
  assert.match(res.warning ?? '', /NOT silently stripped/);
  // The value reached the compiler VERBATIM — stripping it would change the author's filter.
  assert.deepEqual(seen[0].filters, [{ column: 'region', values: ['DE-- drop'] }]);
});
