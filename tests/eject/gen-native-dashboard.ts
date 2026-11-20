/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AT-f fixture writer: the OS's REAL generators (data tab dbt project + semantic layer, native
 * dashboard files) write one domain repo to <out>. No tool runs here; tests/eject/metricflow.sh
 * deletes the OS layer and runs dbt, MetricFlow and vl-convert on it.
 *   node --experimental-strip-types --import ./scripts/test-setup.mjs ../tests/eject/gen-native-dashboard.ts <out>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Dataset } from '@tabs/data/lib/index';

const { generateProject } = await import('@tabs/data/lib/dbt/generate');
const { viewName } = await import('@tabs/data/lib/index');
const { buildSemanticIndex, generateNativeDashboardFiles } = await import('@tabs/dashboards/lib/git/native');
const { projectSnapshot, snapshotDashboard } = await import('@tabs/dashboards/lib/git/snapshot');

const out = process.argv[2];
if (!out) throw new Error('usage: gen-native-dashboard.ts <out-dir>');
const built = (artifact: string, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
const orders = {
  version: '1', id: 'ds_orders1', name: 'Orders', owner: 'amir', domain: 'sales', tier: 'asset', visibility: 'domain', folder: '/',
  description: 'Web-shop orders.', grants: [], viewNamespaced: true,
  columns: [
    { name: 'order_id', description: 'Order key' },
    { name: 'order_date', description: 'Order date' },
    { name: 'region', description: 'Billing region' },
    { name: 'net_amount', description: 'Net amount (EUR)' },
  ],
  versions: { bronze: built('bronze/orders.dlt.yml'), silver: built('silver/stg_orders.sql', true), gold: built('gold/mart_orders.sql', true) },
  measures: [
    { name: 'revenue', type: 'sum', sql: 'net_amount', label: 'Revenue' },
    { name: 'orders', type: 'count', sql: '' },
  ],
} as unknown as Dataset;
const V = viewName(orders);
const repo = new Map<string, string>();
for (const [p, c] of generateProject('sales', { domain: 'sales', datasets: [{ dataset: orders, artifacts: {} }], catalogs: {} }, { dashboardsModelPath: 'dashboards' })) repo.set(p, c);
const index = buildSemanticIndex(repo);
const dash = snapshotDashboard({
  id: 'dash_sales1', owner: 'amir', tier: 'domain', domain: 'sales', folder: '/',
  spec: {
    name: 'Sales Overview', view: V,
    charts: [
      { name: 'Revenue by region', vizType: 'bar', metrics: [`${V}.revenue`], dimensions: [`${V}.region`] },
      { name: 'Orders by month', vizType: 'line', metrics: [`${V}.orders`], timeDimension: `${V}.order_date`, timeGrain: 'month' },
    ],
  },
} as Parameters<typeof snapshotDashboard>[0]);
for (const [p, c] of generateNativeDashboardFiles(projectSnapshot('sales', [dash]), index)) repo.set(p, c);
for (const [p, c] of repo) {
  mkdirSync(path.dirname(path.join(out, p)), { recursive: true });
  writeFileSync(path.join(out, p), c);
}
console.log(`wrote ${repo.size} files to ${out}`);
