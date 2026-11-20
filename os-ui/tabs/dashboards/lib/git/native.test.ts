/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 — a dashboard as dbt saved queries + an exposure + Vega-Lite v5 specs
 * USER STORY: As an engineer I want to clone my domain repo and find each dashboard as plain dbt
 *             and Vega-Lite files that `dbt parse` and `vl-convert` accept with no OS present, and
 *             the OS to draw the dashboard back from exactly those files.
 * ARCHITECTURE:
 *   - Pure: generator + reader + semantic index over the committed dbt YAML. No store, no git.
 *   - The dbt YAML is the golden dbt project `metrics-semantic-layer` (what the data generator
 *     commits today), so the saved queries are written against today's `metrics:` entries.
 *   - The real-tool proof (dbt parse, vl-convert, Trino) is `scripts/tests/dashboards-eject.test.sh`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { projectSnapshot, snapshotDashboard, type StoredDashboard } from '@tabs/dashboards/lib/git/snapshot';
import {
  buildSemanticIndex,
  generateNativeDashboardFiles,
  parseNativeDashboardDir,
  NATIVE_OS_FILE,
  NATIVE_SEMANTIC_FILE,
  VEGA_LITE_SCHEMA,
} from '@tabs/dashboards/lib/git/native';
import { DashboardFileError } from '@tabs/dashboards/lib/git/parse';

const golden = JSON.parse(
  readFileSync(new URL('../../../data/lib/dbt/fixtures/metrics-semantic-layer.golden.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const repo = new Map(Object.entries(golden));
const index = buildSemanticIndex(repo);

const V = 'sales__Orders';
const stored: StoredDashboard = {
  id: 'dash_sales_ab12cd',
  owner: 'amir',
  tier: 'domain',
  domain: 'sales',
  folder: '/weekly',
  spec: {
    name: 'Sales Overview',
    view: V,
    charts: [
      { name: 'Total revenue', vizType: 'big_number', metrics: [`${V}.revenue`] },
      {
        name: 'Revenue by region',
        vizType: 'bar',
        metrics: [`${V}.revenue`],
        dimensions: [`${V}.region`],
        filters: [{ member: `${V}.region`, operator: 'in', values: ['eu', "o'hare"] }],
        gridPos: { x: 0, y: 0, w: 6, h: 2 },
      },
      { name: 'Orders over time', vizType: 'line', metrics: [`${V}.orders`, `${V}.revenue`], timeDimension: `${V}.order_date`, timeGrain: 'month' },
      { name: 'Region split', vizType: 'pie', metrics: [`${V}.customers`], dimensions: [`${V}.region`] },
      { name: 'By region table', vizType: 'table', metrics: [`${V}.revenue`, `${V}.orders`], dimensions: [`${V}.region`] },
      { name: 'Legacy KPI', vizType: 'line', metrics: ['Other.not_in_dbt'] },
    ],
  },
};
const snapshot = projectSnapshot('sales', [snapshotDashboard(stored, { memberRef: (m) => (m.startsWith(`${V}.`) ? `metric:ds_orders1.${m.split('.')[1]}` : null) })]);
const files = generateNativeDashboardFiles(snapshot, index);
const DIR = 'dashboards/sales-overview';
const sem = load(files.get(`${DIR}/${NATIVE_SEMANTIC_FILE}`) ?? '') as {
  saved_queries: { name: string; query_params: { metrics: string[]; group_by?: string[]; where?: string[] }; config?: { meta?: Record<string, unknown> } }[];
  exposures: { name: string; type: string; owner: { name: string }; depends_on: string[]; meta: Record<string, unknown> }[];
};
const sq = (panel: string) => sem.saved_queries.find((s) => s.config?.meta?.os_panel === panel);
const vl = (panel: string) => JSON.parse(files.get(`${DIR}/panels/${panel}.vl.json`) ?? 'null');
const dirFiles = (dir = DIR) =>
  new Map([...files.entries()].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, c]) => [p.slice(dir.length + 1), c]));

test('the semantic index reads today’s committed dbt metrics: member → metric, entity and dimensions', () => {
  assert.equal(index.metricByMember.get(`${V}.revenue`), 'revenue');
  assert.equal(index.metricByMember.get(`${V}.orders`), 'orders');
  assert.equal(index.dimension(V, 'region')?.qualified, 'orders__region');
  assert.equal(index.dimension(V, 'order_date')?.type, 'time');
});

test('each resolvable panel is ONE dbt saved query over today’s metrics, with MetricFlow group_by and where', () => {
  const bar = sq('p_revenue-by-region')!;
  assert.ok(bar, 'the bar panel has a saved query');
  assert.deepEqual(bar.query_params.metrics, ['revenue']);
  assert.deepEqual(bar.query_params.group_by, ["Dimension('orders__region')"]);
  assert.deepEqual(bar.query_params.where, ["{{ Dimension('orders__region') }} IN ('eu', 'o''hare')"]);
  const line = sq('p_orders-over-time')!;
  assert.deepEqual(line.query_params.metrics, ['orders', 'revenue']);
  assert.deepEqual(line.query_params.group_by, ["TimeDimension('orders__order_date', 'month')"]);
  // dbt's own naming rule (it refused `a__b` in the real parse): lower-case, no dunder.
  for (const s of sem.saved_queries) assert.match(s.name, /^[a-z](?!.*__)[a-z0-9_]*[a-z0-9]$/, s.name);
});

test('the dashboard is one dbt exposure of type dashboard that depends on the metrics it charts', () => {
  assert.equal(sem.exposures.length, 1);
  const e = sem.exposures[0];
  assert.equal(e.type, 'dashboard');
  assert.equal(e.name, 'sales_overview');
  assert.deepEqual(e.depends_on, ["metric('customers')", "metric('orders')", "metric('revenue')"]);
  assert.equal(e.meta.os_dashboard, stored.id, 'OS identity only in the documented `meta` extension point');
  assert.match(e.owner.name, /^[0-9a-f]{12}$/, 'the owner is the opaque token, never the user id');
});

test('each panel is a Vega-Lite v5 spec whose named data source IS its saved query', () => {
  const bar = vl('p_revenue-by-region');
  assert.equal(bar.$schema, VEGA_LITE_SCHEMA);
  assert.deepEqual(bar.data, { name: sq('p_revenue-by-region')!.name });
  assert.equal(bar.mark.type, 'bar');
  assert.equal(bar.encoding.x.field, 'orders__region');
  assert.equal(bar.encoding.y.field, 'revenue');
  assert.equal(vl('p_total-revenue').mark.type, 'text');
  assert.equal(vl('p_region-split').mark.type, 'arc');
  assert.equal(vl('p_orders-over-time').encoding.x.field, 'orders__order_date__month', 'MetricFlow’s own column name');
  for (const [p, c] of files) {
    if (!p.endsWith('.vl.json')) continue;
    assert.ok(!/"os[_:]/.test(c) && !('os' in JSON.parse(c)), `${p} carries no OS key`);
  }
});

test('a member with no dbt metric is NOT written as a saved query — it is pending in os.yaml, loudly', () => {
  assert.equal(sq('p_legacy-kpi'), undefined, 'a saved query naming a metric dbt lacks would fail `dbt parse` for the whole domain');
  const os = load(files.get(`${DIR}/${NATIVE_OS_FILE}`) ?? '') as { spec: { panels: { id: string; savedQuery?: string; pending?: { reason: string; metrics: { member: string }[] } }[] } };
  const legacy = os.spec.panels.find((p) => p.id === 'p_legacy-kpi')!;
  assert.equal(legacy.savedQuery, undefined);
  assert.match(legacy.pending!.reason, /Other\.not_in_dbt/);
  assert.deepEqual(legacy.pending!.metrics.map((m) => m.member), ['Other.not_in_dbt']);
  assert.match(files.get(`${DIR}/README.md`) ?? '', /not yet a dbt saved query/i);
});

test('ROUND TRIP: the OS reads the dashboard back from the files and regenerates identical bytes', () => {
  const back = parseNativeDashboardDir(dirFiles(), index, DIR);
  assert.deepEqual(
    back.panels.map((p) => [p.id, p.viz]),
    [['p_total-revenue', 'big_number'], ['p_revenue-by-region', 'bar'], ['p_orders-over-time', 'line'], ['p_region-split', 'pie'], ['p_by-region-table', 'table'], ['p_legacy-kpi', 'line']],
  );
  const bar = back.panels[1];
  assert.deepEqual(bar.metrics, [{ member: `${V}.revenue`, ref: 'metric:ds_orders1.revenue' }]);
  assert.deepEqual(bar.dimensions, [`${V}.region`]);
  assert.deepEqual(bar.filters, [{ member: `${V}.region`, operator: 'in', values: ['eu', "o'hare"] }]);
  assert.deepEqual(back.panels[2].timeDimension, `${V}.order_date`);
  assert.deepEqual(back.panels[2].timeGrain, 'month');
  const again = generateNativeDashboardFiles(projectSnapshot('sales', [back]), index);
  assert.deepEqual([...again.entries()], [...files.entries()]);
});

test('the chart type comes from the Vega-Lite file: editing the mark changes what the OS draws', () => {
  const edited = dirFiles();
  const spec = JSON.parse(edited.get('panels/p_revenue-by-region.vl.json')!);
  spec.mark.type = 'line';
  edited.set('panels/p_revenue-by-region.vl.json', JSON.stringify(spec));
  assert.equal(parseNativeDashboardDir(edited, index, DIR).panels[1].viz, 'line');
});

test('the numbers come from the saved query: editing its metric changes what the OS queries', () => {
  const edited = dirFiles();
  edited.set(NATIVE_SEMANTIC_FILE, edited.get(NATIVE_SEMANTIC_FILE)!.replace(/metrics:\n {8}- revenue\n {6}group_by:\n {8}- Dimension\('orders__region'\)/, "metrics:\n        - customers\n      group_by:\n        - Dimension('orders__region')"));
  assert.deepEqual(parseNativeDashboardDir(edited, index, DIR).panels[1].metrics.map((m) => m.member), [`${V}.customers`]);
});

test('NEGATIVE TWIN: a saved query that names a metric the dbt project lacks is refused by name', () => {
  const edited = dirFiles();
  edited.set(NATIVE_SEMANTIC_FILE, edited.get(NATIVE_SEMANTIC_FILE)!.replace(/- revenue\n/, '- no_such_metric\n'));
  assert.throws(() => parseNativeDashboardDir(edited, index, DIR), (e: Error) => e instanceof DashboardFileError && /no_such_metric/.test(e.message));
});

test('NEGATIVE TWIN: a deleted saved query is not silently served — the panel fails to read', () => {
  const edited = dirFiles();
  const doc = load(edited.get(NATIVE_SEMANTIC_FILE)!) as { saved_queries: { config?: { meta?: { os_panel?: string } } }[] };
  doc.saved_queries = doc.saved_queries.filter((s) => s.config?.meta?.os_panel !== 'p_revenue-by-region');
  edited.set(NATIVE_SEMANTIC_FILE, JSON.stringify(doc));
  assert.throws(() => parseNativeDashboardDir(edited, index, DIR), /p_revenue-by-region/);
});

test('NEGATIVE TWIN: an OS key or a raw-SQL key in a Vega-Lite spec is refused (contract C2)', () => {
  for (const bad of [{ os: { owner: 'x' } }, { sql: 'select 1' }]) {
    const edited = dirFiles();
    const spec = { ...JSON.parse(edited.get('panels/p_revenue-by-region.vl.json')!), ...bad };
    edited.set('panels/p_revenue-by-region.vl.json', JSON.stringify(spec));
    assert.throws(() => parseNativeDashboardDir(edited, index, DIR), DashboardFileError);
  }
});

test('a filter value that could break out of a MetricFlow where template is never written natively', () => {
  const s: StoredDashboard = { ...stored, id: 'dash_inj', spec: { ...stored.spec, name: 'Inj', charts: [{ name: 'X', vizType: 'bar', metrics: [`${V}.revenue`], dimensions: [`${V}.region`], filters: [{ member: `${V}.region`, operator: 'equals', values: ["eu') }} or {{ x"] }] }] } };
  const out = generateNativeDashboardFiles(projectSnapshot('sales', [snapshotDashboard(s)]), index);
  const doc = load(out.get('dashboards/inj/semantic.yml')!) as { saved_queries?: unknown[] };
  assert.equal(doc.saved_queries, undefined);
  assert.match(out.get('dashboards/inj/os.yaml')!, /pending:/);
});
