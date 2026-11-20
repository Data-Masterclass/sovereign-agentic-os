/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 — the OS draws a native dashboard FROM GIT, and every number is queried as the viewer
 * USER STORY: As a viewer I want the dashboard drawn from the saved queries and Vega-Lite specs
 *             committed in my domain's repository, with my own row-level security applied, so two
 *             people opening the same dashboard see the rows their entitlements allow.
 * ARCHITECTURE:
 *   - A REAL git repository (the git store, temp dir) holds the data tab's dbt project and the
 *     native dashboard files; `nativeSpecForView` reads them back at `main`.
 *   - Each panel runs through `runPanelQuery` → `exploreMetric` → `builtLayerFqn` (#189/#192) on the
 *     lakehouse harness's Trino 476 + OPA (the chart's policies and governance data). Only `queryRun`
 *     is replaced, by a pass-through that sends os-ui's SQL to that Trino AS the viewer.
 *   - The chart's governance data governs `iceberg.sales.gold_northpeak_commerce` (domain `sales`):
 *     principal `sales` is a member, `marketing-agent` is not, so OPA's row filter returns no rows.
 *   - NEGATIVE TWINS: a commit that deletes a panel's saved query makes the dashboard unavailable
 *     (never drawn from the registry); a commit that changes a mark changes what the OS draws.
 *   - Runs when LH_TRINO_URL is set (CI job test-lakehouse); skipped otherwise.
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Dataset } from '@tabs/data/lib/index';
// @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs), no type declarations
import { run } from '../../../../../tests/lakehouse/lib.mjs';

const skip = process.env.LH_TRINO_URL ? false : 'LH_TRINO_URL not set (start tests/lakehouse/up.sh)';
const trino = (sql: string, user: string): Promise<{ columns: string[]; rows: unknown[][] }> => run(sql, { user, source: 'os-ui-it' });

mock.module('@core/infra/governed', {
  namedExports: {
    queryRun: async (sql: string, principal?: string) => {
      const r = await trino(sql, principal ?? 'anonymous');
      return { engine: 'trino', tables: [], columns: r.columns, rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))), rowCount: r.rows.length };
    },
  },
});
mock.module('../../../metrics/lib/build/live-clients.ts', { namedExports: { liveMetricsReachable: async () => true } });

const { commitTree } = await import('@core/infra/git-store');
const { generateProject } = await import('@tabs/data/lib/dbt/generate');
const { viewName } = await import('@tabs/data/lib/index');
const { builtLayerFqn } = await import('@tabs/data/lib/store-fqn');
const { viewerToken } = await import('@tabs/metrics/lib/fixtures');
const { runPanelQuery } = await import('@tabs/dashboards/lib/build/panel-query');
const { buildSemanticIndex, generateNativeDashboardFiles } = await import('@tabs/dashboards/lib/git/native');
const { nativeSpecForView } = await import('@tabs/dashboards/lib/git/native-git');
const { projectSnapshot, snapshotDashboard } = await import('@tabs/dashboards/lib/git/snapshot');

const reposDir = mkdtempSync(path.join(tmpdir(), 'wp52-repos-'));
const author = { name: 'Test', email: 'test@os.local' };
const built = (artifact: string, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
// The chart's governance data names this table: domain `sales`, visibility `domain`.
const dataset: Dataset = {
  version: '1', id: 'ds_np_commerce', name: 'Northpeak Commerce', owner: 'dbt-sales', domain: 'sales', tier: 'asset', visibility: 'domain', folder: '/',
  description: '', grants: [], viewNamespaced: true,
  columns: [{ name: 'order_id', description: '' }, { name: 'order_date', description: '' }, { name: 'region', description: '' }, { name: 'net_amount', description: '' }],
  versions: { bronze: built('bronze/x.dlt.yml'), silver: built('silver/x.sql', true), gold: built('gold/x.sql', true) },
  measures: [{ name: 'revenue', type: 'sum', sql: 'net_amount' }],
} as unknown as Dataset;
const V = viewName(dataset);
const TABLE = 'iceberg.sales.gold_northpeak_commerce';
const resolve = (member: string) => (member === `${V}.revenue` ? { dataset, measure: dataset.measures[0] } : null);

const repoFiles = new Map<string, string>();
before(async () => {
  if (skip) return;
  for (const [p, c] of generateProject('sales', { domain: 'sales', datasets: [{ dataset, artifacts: {} }], catalogs: {} }, { dashboardsModelPath: 'dashboards' })) repoFiles.set(p, c);
  const index = buildSemanticIndex(repoFiles);
  const dash = snapshotDashboard({
    id: 'dash_np1', owner: 'dbt-sales', tier: 'domain', domain: 'sales', folder: '/',
    spec: { name: 'Northpeak', view: V, charts: [{ name: 'Revenue by region', vizType: 'bar', metrics: [`${V}.revenue`], dimensions: [`${V}.region`] }] },
  });
  for (const [p, c] of generateNativeDashboardFiles(projectSnapshot('sales', [dash]), index)) repoFiles.set(p, c);
  await commitTree('sales', repoFiles, { author, message: 'seed', reposDir });
  await trino('CREATE SCHEMA IF NOT EXISTS iceberg.sales', 'dbt-sales');
  await trino(`CREATE TABLE IF NOT EXISTS ${TABLE} (order_id integer, order_date date, region varchar, net_amount double)`, 'dbt-sales');
  await trino(`DELETE FROM ${TABLE}`, 'dbt-sales');
  await trino(`INSERT INTO ${TABLE} VALUES (1, DATE '2026-11-01', 'eu', 10.5), (2, DATE '2026-11-02', 'us', 20.0), (3, DATE '2026-11-02', 'eu', 1.5)`, 'dbt-sales');
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

const draw = async (viewer: string, domains: string[]) => {
  const native = await nativeSpecForView('sales', 'dash_np1', { reposDir });
  assert.ok(!('unavailable' in native), `drawn from git: ${'unavailable' in native ? native.unavailable : ''}`);
  const [panel] = native.spec.charts;
  const r = await runPanelQuery(V, panel, viewerToken({ id: viewer, domains, role: 'creator', attributes: {} }), { id: viewer, domains, role: 'creator' }, { resolve });
  return { native, panel, r, byRegion: Object.fromEntries(r.rows.map((row) => [row[`${V}.region`], row[`${V}.revenue`]])) };
};

test('the OS draws the panel from the committed files and queries the table builtLayerFqn names, AS the viewer', { skip }, async () => {
  assert.equal(builtLayerFqn(dataset, { id: 'sales', domains: ['sales'] }, 'gold')?.fqn, TABLE);
  const { native, panel, r, byRegion } = await draw('sales', ['sales']);
  assert.match(native.dir, /^dashboards\/northpeak$/);
  assert.equal(panel.vizType, 'bar', 'the viz is the Vega-Lite mark');
  assert.deepEqual(panel.dimensions, [`${V}.region`], 'the group-by is the saved query’s');
  assert.ok(r.sql.includes(`FROM ${TABLE}`), r.sql);
  assert.deepEqual(byRegion, { eu: 12, us: 20 });
});

test('OPA row filter: a viewer outside the domain gets NO rows from the same dashboard', { skip }, async () => {
  const { byRegion } = await draw('marketing-agent', ['marketing']);
  assert.deepEqual(byRegion, {}, 'Trino/OPA filtered every row for a non-member');
});

test('NEGATIVE TWIN: the same SQL as the domain member really returns rows (the filter is OPA, not the query)', { skip }, async () => {
  const { r } = await draw('sales', ['sales']);
  assert.ok((await trino(r.sql, 'sales')).rows.length > 0);
  assert.equal((await trino(r.sql, 'marketing-agent')).rows.length, 0);
});

test('NEGATIVE TWIN: change the mark in git and the OS draws a line; delete the saved query and it draws nothing', { skip }, async () => {
  const vlPath = 'dashboards/northpeak/panels/p_revenue-by-region.vl.json';
  const spec = JSON.parse(repoFiles.get(vlPath)!);
  await commitTree('sales', new Map([...repoFiles, [vlPath, JSON.stringify({ ...spec, mark: { type: 'line' } })]]), { author, message: 'line', reposDir });
  assert.equal((await draw('sales', ['sales'])).panel.vizType, 'line');
  const sem = 'dashboards/northpeak/semantic.yml';
  const without = repoFiles.get(sem)!.replace(/saved_queries:[\s\S]*?exposures:/, 'exposures:');
  await commitTree('sales', new Map([...repoFiles, [sem, without]]), { author, message: 'drop sq', reposDir });
  const native = await nativeSpecForView('sales', 'dash_np1', { reposDir });
  assert.ok('unavailable' in native && /saved query/.test(native.unavailable), JSON.stringify(native));
});
