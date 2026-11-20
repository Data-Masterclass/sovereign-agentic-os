/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 EJECT TEST — a dashboard runs on dbt, Trino and vl-convert with no OS present
 * USER STORY: As the owner I want to take a domain repo, delete every OS file, and still validate
 *             the dashboard with `dbt parse`, run its panel queries on a plain Trino and render every
 *             chart with vl-convert — the same numbers the OS draws.
 * ARCHITECTURE:
 *   - The repo is the REAL generators' output: the data tab's dbt generator (today's `metrics:`)
 *     plus the native dashboard generator, written to disk; then `dashboards/**\/os.yaml` and
 *     `dashboards/index.yml` (the OS layer) are deleted before any tool runs.
 *   - dbt: `dbt parse` in the chart's Dagster image (dbt-core 1.9, dbt-semantic-interfaces 0.7.5).
 *   - Trino: a PLAIN `trinodb/trino:476` (the chart's tag) with an in-memory catalog — no OPA, no
 *     OS config. The SQL is the OS's own panel SQL (`runPanelQuery` → `exploreMetric` →
 *     `builtLayerFqn`); only `queryRun` is replaced by a pass-through to that Trino.
 *   - Vega-Lite: `vl-convert-python` 1.8.0 renders each spec (VL 5.21) with the Trino rows inlined
 *     by name; `jsonschema` validates it against the Vega-Lite v5.21.0 JSON Schema.
 *   - Dual render: the ECharts option the OS draws for the same panel carries the same values.
 *   - NEGATIVE TWINS: a saved query naming an unknown metric fails `dbt parse`; an `os:` block in a
 *     spec fails the Vega-Lite schema.
 *   - Runs when WP52_EJECT=1 (CI job `dashboards-eject`); skipped otherwise.
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Dataset } from '@tabs/data/lib/index';

const skip = process.env.WP52_EJECT === '1' ? false : 'WP52_EJECT not set (needs docker)';
const DAGSTER_IMAGE = process.env.DAGSTER_IMAGE ?? 'ghcr.io/data-masterclass/sovereign-os/dagster:0.3.2';
const TRINO_IMAGE = process.env.TRINO_IMAGE ?? 'trinodb/trino:476';
const PY_IMAGE = 'python:3.12-slim';
const VL_PIP = 'vl-convert-python==1.8.0 jsonschema==4.23.0';
const VL_SCHEMA_URL = 'https://vega.github.io/schema/vega-lite/v5.21.0.json';

// Under $HOME: colima / Docker Desktop share it with the VM, macOS's /var/folders they do not.
const WORK = skip ? '' : mkdtempSync(path.join(process.env.WP52_TMP ?? path.join(homedir(), '.cache'), 'wp52-eject-'));
const CTR = `wp52-eject-trino-${process.pid}`;
const sh = (cmd: string, args: string[], opts: { input?: string } = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });
const shOk = (cmd: string, args: string[]) => {
  try {
    return { ok: true, out: sh(cmd, args) };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
  }
};
let trinoUrl = '';

mock.module('@core/infra/governed', {
  namedExports: {
    queryRun: async (sql: string, principal?: string) => {
      // @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs)
      const { run } = await import('../lakehouse/lib.mjs');
      const r = await run(sql, { user: principal ?? 'eject', source: 'wp52-eject' });
      return { engine: 'trino', tables: [], columns: r.columns, rows: r.rows.map((row: unknown[]) => row.map((v) => (v === null ? null : String(v)))), rowCount: r.rows.length };
    },
  },
});
mock.module('../../os-ui/tabs/metrics/lib/build/live-clients.ts', { namedExports: { liveMetricsReachable: async () => true } });

const { generateProject } = await import('@tabs/data/lib/dbt/generate');
const { viewName } = await import('@tabs/data/lib/index');
const { builtLayerFqn } = await import('@tabs/data/lib/store-fqn');
const { viewerToken } = await import('@tabs/metrics/lib/fixtures');
const { runPanelQuery } = await import('@tabs/dashboards/lib/build/panel-query');
const { buildSemanticIndex, generateNativeDashboardFiles, readNativeDashboards, nativeToSpec } = await import('@tabs/dashboards/lib/git/native');
const { projectSnapshot, snapshotDashboard } = await import('@tabs/dashboards/lib/git/snapshot');
const { panelChartSpec } = await import('@tabs/dashboards/lib/chart-spec');
const { buildChartOption } = await import('@core/ui/charts/spec');
const { resolveChartColors } = await import('@core/ui/charts/theme');

const built = (artifact: string, passThrough = false) => ({ built: true, passThrough, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });
const orders: Dataset = {
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
let index: ReturnType<typeof buildSemanticIndex>;

before(async () => {
  if (skip) return;
  for (const [p, c] of generateProject('sales', { domain: 'sales', datasets: [{ dataset: orders, artifacts: {} }], catalogs: {} }, { dashboardsModelPath: 'dashboards' })) repo.set(p, c);
  index = buildSemanticIndex(repo);
  const dash = snapshotDashboard({
    id: 'dash_sales1', owner: 'amir', tier: 'domain', domain: 'sales', folder: '/',
    spec: {
      name: 'Sales Overview', view: V,
      charts: [
        { name: 'Revenue by region', vizType: 'bar', metrics: [`${V}.revenue`], dimensions: [`${V}.region`] },
        { name: 'Revenue EU', vizType: 'big_number', metrics: [`${V}.revenue`], filters: [{ member: `${V}.region`, operator: 'equals', values: ['eu'] }] },
        { name: 'Orders by month', vizType: 'line', metrics: [`${V}.orders`], timeDimension: `${V}.order_date`, timeGrain: 'month' },
      ],
    },
  });
  for (const [p, c] of generateNativeDashboardFiles(projectSnapshot('sales', [dash]), index)) repo.set(p, c);
  // The ejected clone: every file, then the OS layer deleted.
  for (const [p, c] of repo) {
    if (p.endsWith('/os.yaml') || p === 'dashboards/index.yml') continue;
    mkdirSync(path.dirname(path.join(WORK, 'repo', p)), { recursive: true });
    writeFileSync(path.join(WORK, 'repo', p), c);
  }
  execFileSync('chmod', ['-R', 'a+rwX', WORK]);
  // A PLAIN Trino: the chart's image tag, an in-memory catalog named like the profile's, nothing else.
  mkdirSync(path.join(WORK, 'trino'), { recursive: true });
  writeFileSync(path.join(WORK, 'trino/iceberg.properties'), 'connector.name=memory\n');
  execFileSync('chmod', ['-R', 'a+rX', WORK]);
  sh('docker', ['run', '-d', '--name', CTR, '-p', '127.0.0.1::8080', '-v', `${path.join(WORK, 'trino/iceberg.properties')}:/etc/trino/catalog/iceberg.properties:ro`, TRINO_IMAGE]);
  const port = sh('docker', ['port', CTR, '8080/tcp']).trim().split(':').pop();
  trinoUrl = `http://127.0.0.1:${port}`;
  process.env.LH_TRINO_URL = trinoUrl;
  for (let i = 0; i < 120 && !shOk('docker', ['exec', CTR, 'trino', '--execute', 'SELECT 1']).ok; i++) await new Promise((r) => setTimeout(r, 2000));
  const fqn = builtLayerFqn(orders, { id: 'amir', domains: ['sales'] }, 'gold')!.fqn;
  const [cat, schema] = fqn.split('.');
  sh('docker', ['exec', CTR, 'trino', '--execute', `CREATE SCHEMA ${cat}.${schema}`]);
  sh('docker', ['exec', CTR, 'trino', '--execute', `CREATE TABLE ${fqn} (order_id integer, order_date date, region varchar, net_amount double)`]);
  sh('docker', ['exec', CTR, 'trino', '--execute', `INSERT INTO ${fqn} VALUES (1, DATE '2026-09-03', 'eu', 10.5), (2, DATE '2026-09-20', 'us', 20.0), (3, DATE '2026-10-02', 'eu', 1.5), (4, DATE '2026-10-09', 'apac', 4.0)`]);
});

after(() => {
  if (skip) return;
  shOk('docker', ['rm', '-f', CTR]);
  // dbt and vl-convert wrote `target/`, `logs/` and SVGs as the image user: hand them back first.
  shOk('docker', ['run', '--rm', '-u', '0', '-v', `${WORK}:/w`, PY_IMAGE, 'chmod', '-R', 'a+rwX', '/w']);
  if (WORK) rmSync(WORK, { recursive: true, force: true });
});

const dbtParse = (dir: string) =>
  shOk('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/p`, '-w', '/p', '-e', 'HOME=/tmp', '-e', 'OS_PRINCIPAL=eject', '-e', 'TRINO_USER=eject', DAGSTER_IMAGE, 'dbt', 'parse', '--profiles-dir', '.', '--no-partial-parse']);

test('EJECT: with the OS layer deleted, `dbt parse` accepts every saved query and the exposure', { skip }, () => {
  assert.ok(!existsSync(path.join(WORK, 'repo/dashboards/sales-overview/os.yaml')), 'the OS layer is gone');
  const r = dbtParse(path.join(WORK, 'repo'));
  assert.ok(r.ok, `dbt parse failed:\n${r.out.slice(-2000)}`);
  const m = JSON.parse(readFileSync(path.join(WORK, 'repo/target/manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.saved_queries).sort(), [
    'saved_query.sales.sales_overview_orders_by_month',
    'saved_query.sales.sales_overview_revenue_by_region',
    'saved_query.sales.sales_overview_revenue_eu',
  ]);
  const e = m.exposures['exposure.sales.sales_overview'];
  assert.equal(e.type, 'dashboard');
  assert.deepEqual(e.depends_on.nodes.sort(), ['metric.sales.orders', 'metric.sales.revenue']);
});

test('NEGATIVE TWIN: a saved query naming a metric the project lacks fails `dbt parse`', { skip }, () => {
  const twin = path.join(WORK, 'twin-dbt');
  cpSync(path.join(WORK, 'repo'), twin, { recursive: true });
  rmSync(path.join(twin, 'target'), { recursive: true, force: true });
  const f = path.join(twin, 'dashboards/sales-overview/semantic.yml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/- revenue\n/, '- no_such_metric\n'));
  const r = dbtParse(twin);
  assert.equal(r.ok, false, 'dbt must refuse it');
  assert.match(r.out, /no_such_metric/);
});

type Rendered = Record<string, { valid: boolean; errors: string[]; marks: Record<string, number>; svgBytes: number }>;
const vlRender = (dir: string): Rendered => {
  const py = [
    'import json, os, sys, urllib.request, jsonschema, vl_convert as vlc',
    `schema = json.load(urllib.request.urlopen("${VL_SCHEMA_URL}"))`,
    'out = {}',
    'for f in sorted(os.listdir("/w")):',
    '    if not f.endswith(".vl.json"): continue',
    '    spec = json.load(open("/w/" + f))',
    '    errs = [e.message[:200] for e in jsonschema.Draft7Validator(schema).iter_errors(spec)]',
    '    marks = {}',
    '    def walk(n):',
    '        if isinstance(n, dict):',
    '            if n.get("marktype") and n.get("role") == "mark": marks[n["marktype"]] = marks.get(n["marktype"], 0) + len(n.get("items", []))',
    '            for v in n.values(): walk(v)',
    '        elif isinstance(n, list):',
    '            for v in n: walk(v)',
    '    svg = ""',
    '    if not errs:',
    '        walk(vlc.vegalite_to_scenegraph(spec, vl_version="5.21"))',
    '        svg = vlc.vegalite_to_svg(spec, vl_version="5.21")',
    '        open("/w/" + f[:-8] + ".svg", "w").write(svg)',
    '    out[f] = {"valid": not errs, "errors": errs, "marks": marks, "svgBytes": len(svg)}',
    'print(json.dumps(out))',
  ].join('\n');
  writeFileSync(path.join(dir, 'render.py'), py);
  execFileSync('chmod', ['-R', 'a+rwX', dir]);
  const out = sh('docker', ['run', '--rm', '-v', `${dir}:/w`, PY_IMAGE, 'sh', '-c', `pip install -q --disable-pip-version-check ${VL_PIP} >/dev/null 2>&1 && python /w/render.py`]);
  return JSON.parse(out.trim().split('\n').pop()!);
};

test('EJECT: each panel’s OS SQL runs on a PLAIN Trino, and vl-convert renders its spec with those rows', { skip, timeout: 600_000 }, async () => {
  // The OS reads the dashboard back from the files (os.yaml included — the OS side of the coin).
  const [{ dashboard, dir }] = readNativeDashboards(repo, index);
  const spec = nativeToSpec(dashboard);
  const vlDir = path.join(WORK, 'vl');
  mkdirSync(vlDir, { recursive: true });
  const token = viewerToken({ id: 'amir', domains: ['sales'] });
  const resolve = (member: string) => {
    const m = orders.measures.find((x) => `${V}.${x.name}` === member);
    return m ? { dataset: orders, measure: m } : null;
  };
  const expected: Record<string, { values: Record<string, unknown>[]; echarts: unknown }> = {};
  for (const [i, panel] of spec.charts.entries()) {
    const res = await runPanelQuery(V, panel, token, { id: 'amir', domains: ['sales'], role: 'domain_admin' }, { resolve });
    assert.equal(res.mode, 'live', `panel ${panel.name}: ${res.warning ?? ''}`);
    assert.ok(res.sql.includes('FROM iceberg.'), `the OS SQL names the table builtLayerFqn resolves:\n${res.sql}`);
    // Rows by MetricFlow's column names — the names the Vega-Lite spec encodes.
    const rename = (k: string): string => {
      const metric = index.metricByMember.get(k);
      if (metric) return metric;
      const col = k.slice(k.lastIndexOf('.') + 1);
      const d = index.dimension(V, col);
      if (!d) return k;
      return d.type === 'time' && panel.timeGrain ? `${d.qualified}__${panel.timeGrain}` : d.qualified;
    };
    const values = res.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [rename(k), v])));
    const pid = dashboard.panels[i].id;
    const vl = JSON.parse(repo.get(`${dir}/panels/${pid}.vl.json`)!);
    writeFileSync(path.join(vlDir, `${pid}.vl.json`), JSON.stringify({ ...vl, data: { values } }));
    const chart = panelChartSpec(panel, res.rows);
    expected[`${pid}.vl.json`] = { values, echarts: chart ? buildChartOption(chart, resolveChartColors(() => undefined)) : null };
  }
  // A twin spec with an OS block: the Vega-Lite schema must refuse it.
  const anyVl = readdirSync(vlDir).find((f) => f.endsWith('.vl.json'))!;
  writeFileSync(path.join(vlDir, 'zz-twin.vl.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(vlDir, anyVl), 'utf8')), os: { owner: 'x' } }));

  const rendered = vlRender(vlDir);
  assert.equal(rendered['zz-twin.vl.json'].valid, false, 'NEGATIVE TWIN: an `os:` block is not Vega-Lite');
  delete rendered['zz-twin.vl.json'];
  for (const [f, r] of Object.entries(rendered)) {
    assert.ok(r.valid, `${f} is valid Vega-Lite v5: ${r.errors.join('; ')}`);
    assert.ok(r.svgBytes > 500, `${f} rendered to SVG`);
  }
  // The numbers: what plain Trino returned for the OS's SQL.
  const bar = expected['p_revenue-by-region.vl.json'].values;
  assert.deepEqual(Object.fromEntries(bar.map((r) => [r.orders__region, r.revenue])), { eu: 12, us: 20, apac: 4 });
  assert.deepEqual(expected['p_revenue-eu.vl.json'].values, [{ revenue: 12 }]);
  // DUAL RENDER: one bar per row in vl-convert's scene graph, and the same values in the ECharts option.
  assert.equal(rendered['p_revenue-by-region.vl.json'].marks.rect, 3);
  const opt = expected['p_revenue-by-region.vl.json'].echarts as { series: { type: string; data: unknown[] }[] };
  assert.equal(opt.series[0].type, 'bar');
  // ECharts draws [category, value] pairs; the Vega-Lite spec carries the same rows by MetricFlow name.
  const echartsPairs = Object.fromEntries((opt.series[0].data as [string, number][]).map(([k, v]) => [k, Number(v)]));
  const vlPairs = Object.fromEntries(bar.map((r) => [String(r.orders__region), Number(r.revenue)]));
  assert.deepEqual(echartsPairs, vlPairs);
  assert.equal(rendered['p_revenue-eu.vl.json'].marks.text, 1);
  // A Vega line mark has one scene-graph item per point: one per month the OS query returned.
  assert.equal(rendered['p_orders-by-month.vl.json'].marks.line, expected['p_orders-by-month.vl.json'].values.length);
  assert.equal(expected['p_orders-by-month.vl.json'].values.length, 2, 'September and October');
});
