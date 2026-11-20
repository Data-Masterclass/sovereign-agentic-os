/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 golden — a whole domain repo with native dashboards, for GLUE-6 / GLUE-10
 * USER STORY: As a maintainer I want the native dashboard bytes pinned and run through `dbt parse`
 *             and `dagster definitions validate` by scripts/validate-generated.sh on every PR.
 * ARCHITECTURE:
 *   - Base = the data tab's `metrics-semantic-layer` golden (today's dbt `metrics:`), with
 *     `model-paths` extended by `dashboardsModelPath(1)` as the dbt commit does with the flag on;
 *     plus `generateNativeDashboardFiles` for two dashboards (one domain, one personal, one panel
 *     pending because its member has no dbt metric).
 *   - `UPDATE_GOLDENS=1` rewrites the fixture; otherwise the bytes must match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dump, load } from 'js-yaml';
import { dashboardsModelPath } from '@core/infra/repo-layout';
import { buildSemanticIndex, generateNativeDashboardFiles } from '@tabs/dashboards/lib/git/native';
import { projectSnapshot, snapshotDashboard } from '@tabs/dashboards/lib/git/snapshot';

const FIXTURE = new URL('./fixtures/dashboards-native.golden.json', import.meta.url);
const base = JSON.parse(readFileSync(new URL('../../../data/lib/dbt/fixtures/metrics-semantic-layer.golden.json', import.meta.url), 'utf8')) as Record<string, string>;
const V = 'sales__Orders';

function build(): Record<string, string> {
  const project = load(base['dbt_project.yml']) as Record<string, unknown>;
  project['model-paths'] = ['models', dashboardsModelPath(1)];
  const repo = new Map(Object.entries({ ...base, 'dbt_project.yml': dump(project, { lineWidth: -1 }) }));
  const dashboards = [
    snapshotDashboard({
      id: 'dash_sales_overview', owner: 'amir', tier: 'domain', domain: 'sales', folder: '/',
      spec: {
        name: 'Sales Overview', view: V, filters: [{ member: `${V}.region`, operator: 'equals', values: ['eu'] }],
        charts: [
          { name: 'Revenue', vizType: 'big_number', metrics: [`${V}.revenue`] },
          { name: 'Revenue by region', vizType: 'bar', metrics: [`${V}.revenue`], dimensions: [`${V}.region`], filters: [{ member: `${V}.region`, operator: 'in', values: ['eu', 'us'] }], gridPos: { x: 0, y: 0, w: 6, h: 2 } },
          { name: 'Orders and revenue by month', vizType: 'line', metrics: [`${V}.orders`, `${V}.revenue`], timeDimension: `${V}.order_date`, timeGrain: 'month' },
          { name: 'Customers by region', vizType: 'pie', metrics: [`${V}.customers`], dimensions: [`${V}.region`] },
          { name: 'Region table', vizType: 'table', metrics: [`${V}.revenue`, `${V}.aov`], dimensions: [`${V}.region`] },
        ],
      },
    }),
    snapshotDashboard({
      id: 'dash_bea_draft', owner: 'bea', tier: 'personal', domain: 'sales', folder: '/',
      spec: { name: 'My draft', view: V, charts: [{ name: 'Not in dbt yet', vizType: 'area', metrics: ['Other.new_customers'] }, { name: 'AOV', vizType: 'big_number', metrics: [`${V}.aov`] }] },
    }),
  ];
  for (const [p, c] of generateNativeDashboardFiles(projectSnapshot('sales', dashboards), buildSemanticIndex(repo))) repo.set(p, c);
  return Object.fromEntries([...repo.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

test('the native dashboards golden is pinned (UPDATE_GOLDENS=1 rewrites it)', () => {
  const now = build();
  if (process.env.UPDATE_GOLDENS === '1') writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
  // Pinned: every dashboard byte and the dbt model-paths. The rest is the data tab's golden, which
  // that tab pins itself; a change there is picked up by the next UPDATE_GOLDENS=1 run, and
  // validate-generated keeps parsing whatever the fixture holds.
  const ours = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([p]) => p.startsWith('dashboards/')));
  assert.deepEqual(ours(pinned), ours(now));
  assert.deepEqual((load(pinned['dbt_project.yml']) as Record<string, unknown>)['model-paths'], ['models', 'dashboards']);
});
