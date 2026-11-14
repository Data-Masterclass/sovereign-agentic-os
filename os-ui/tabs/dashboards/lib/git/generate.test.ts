/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    Goldens, round-trip and byte-stability for dashboard-as-code (D8, D9)
 * USER STORY: As a maintainer I want the committed bytes pinned, so a generator change that would
 *             churn every domain's repository shows up here rather than as a thousand-file diff.
 * ARCHITECTURE:
 *   - Pure: the generator, the parser and the snapshot only. No store, no git, no clock, no `.tsx`.
 *   - In the style of `tabs/agents/lib/git/generate.test.ts`: one golden fixture, one round trip,
 *     one idempotence assertion, plus the refusals that make the format safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARDS_PREFIX,
  generateDashboardFiles,
  ownerRef,
  placeDashboards,
  renderDashboardYaml,
  sourcesOf,
} from '@tabs/dashboards/lib/git/generate';
import { ownerToken, projectSnapshot, segment, snapshotDashboard, type SnapshotDashboard, type StoredDashboard } from '@tabs/dashboards/lib/git/snapshot';
import { parseDashboardFile, importDashboard, DashboardFileError } from '@tabs/dashboards/lib/git/parse';

const OWNER = 'alex@datamasterclass.com';

const stored: StoredDashboard = {
  id: 'dash_sales_overview_ab12cd',
  owner: OWNER,
  tier: 'domain',
  domain: 'analytics',
  folder: '/weekly',
  spec: {
    name: 'Sales Overview',
    view: 'Orders',
    domain: 'analytics',
    filters: [{ member: 'Orders.region', operator: 'equals', values: ['DE'] }],
    charts: [
      { name: 'Total revenue', vizType: 'big_number', metrics: ['Orders.revenue'] },
      {
        name: 'Revenue over time',
        vizType: 'line',
        metrics: ['Orders.revenue', 'Orders.order_count'],
        timeDimension: 'Orders.order_date',
        timeGrain: 'month',
        gridPos: { x: 0, y: 0, w: 8, h: 2 },
      },
      {
        name: 'Revenue by region',
        vizType: 'bar',
        metrics: ['Orders.revenue'],
        dimensions: ['Orders.region'],
        filters: [{ member: 'Orders.channel', operator: 'in', values: ['web', 'retail'] }],
      },
    ],
  },
};

const resolvers = {
  memberRef: (m: string) =>
    ({
      'Orders.revenue': 'metric:met_orders_revenue',
      'Orders.order_count': 'metric:met_orders_count',
    })[m] ?? null,
  viewRef: (v: string) => (v === 'Orders' ? 'dataset:ds_orders_gold' : null),
};

function snapshot(): SnapshotDashboard {
  return snapshotDashboard(stored, resolvers);
}

// ------------------------------------------------------------------- placement ---

test('the opaque owner token is the agents side’s token, byte for byte', () => {
  // Both generators must hash a principal identically, or one repository would carry two tokens
  // for the same person. The agents twin is `tabs/agents/lib/git/generate.ts` `ownerToken`.
  assert.equal(ownerToken('alex@datamasterclass.com'), 'fc4a050fe512');
  assert.equal(ownerToken(''), ownerToken(undefined as unknown as string));
  assert.match(ownerToken(OWNER), /^[0-9a-f]{12}$/);
});

test('no principal identifier appears anywhere in the generated tree', () => {
  const files = generateDashboardFiles(projectSnapshot('analytics', [snapshot()]));
  for (const [path, content] of files) {
    assert.ok(!path.includes(OWNER), `${path} names the principal`);
    assert.ok(!content.includes(OWNER), `${path} contents name the principal`);
    assert.ok(!content.includes('datamasterclass.com'), `${path} leaks an e-mail domain`);
  }
});

test('a domain dashboard sits in the domain tree; a personal one in the owner’s lane', () => {
  const domain = snapshot();
  const personal: SnapshotDashboard = { ...snapshot(), id: 'dash_mine_zz', name: 'Mine', tier: 'personal' };
  const placed = placeDashboards(projectSnapshot('analytics', [domain, personal]));
  const byId = new Map(placed.map((p) => [p.dashboard.id, p]));
  assert.equal(byId.get('dash_sales_overview_ab12cd')!.dir, 'dashboards/sales-overview');
  assert.equal(byId.get('dash_mine_zz')!.dir, `dashboards/personal/${ownerToken(OWNER)}/mine`);
});

test('two dashboards that slug alike are disambiguated deterministically', () => {
  const a: SnapshotDashboard = { ...snapshot(), id: 'dash_a' };
  const b: SnapshotDashboard = { ...snapshot(), id: 'dash_b' };
  const placed = placeDashboards(projectSnapshot('analytics', [a, b]));
  assert.deepEqual(placed.map((p) => p.dir).sort(), ['dashboards/sales-overview', 'dashboards/sales-overview-dash-b'].sort());
  // Deterministic: the same set placed again gives the same directories.
  assert.deepEqual(placeDashboards(projectSnapshot('analytics', [b, a])).map((p) => p.dir).sort(), placed.map((p) => p.dir).sort());
});

test('a domain dashboard called “Personal” cannot shadow the personal lane', () => {
  const sneaky: SnapshotDashboard = { ...snapshot(), id: 'dash_sneaky', name: 'Personal', tier: 'domain' };
  const [placed] = placeDashboards(projectSnapshot('analytics', [sneaky]));
  assert.notEqual(placed.dir, 'dashboards/personal');
  assert.match(placed.dir, /^dashboards\/personal-/);
});

test('segment never yields an empty or traversing path piece', () => {
  assert.equal(segment('Sales Overview', 'x'), 'sales-overview');
  assert.equal(segment('../../etc/passwd', 'x'), 'etc-passwd');
  assert.equal(segment('   ', 'fallback'), 'fallback');
});

// ---------------------------------------------------------------------- golden ---

const GOLDEN_YAML = `# A Sovereign OS dashboard, as code. Generated by the OS; safe to hand-edit and push back —
# the receive gate validates this file with the SAME schema the UI and the MCP use.
#
# \`spec.sources[].ref\` is a STABLE OS ID (\`metric:<id>\` / \`dataset:<id>\`). A panel addresses
# governed metric members ONLY: there is no SQL field, and there never will be, so a dashboard
# file cannot smuggle a query past the metric registry. Every number is still resolved live,
# as the VIEWER, with that viewer's row-level security applied.
apiVersion: os.sovereign/v1
kind: Dashboard
metadata:
  id: dash_sales_overview_ab12cd
  name: Sales Overview
  domain: analytics
  owner: fc4a050fe512   # opaque token for the owning principal (sha256 prefix)
  tier: domain                 # personal | domain | marketplace (the AUDIENCE ladder)
  folder: '/weekly'
spec:
  view: Orders
  sources:
    - ref: dataset:ds_orders_gold
      view: Orders
    - ref: metric:met_orders_revenue
      member: Orders.revenue
    - ref: metric:met_orders_count
      member: Orders.order_count
  filters:                        # the dashboard's authored default filter chips
    - member: Orders.region
      operator: equals
      values: [DE]
  panels:
    - id: p_total-revenue
      name: Total revenue
      viz: big_number
      metrics: [Orders.revenue]
    - id: p_revenue-over-time
      name: Revenue over time
      viz: line
      metrics: [Orders.revenue, Orders.order_count]
      timeDimension: Orders.order_date
      timeGrain: month
      gridPos: { x: 0, y: 0, w: 8, h: 2 }
    - id: p_revenue-by-region
      name: Revenue by region
      viz: bar
      metrics: [Orders.revenue]
      dimensions: [Orders.region]
      filters:
        - member: Orders.channel
          operator: in
          values: [web, retail]
`;

test('golden — the committed dashboard.yaml bytes', () => {
  const [placed] = placeDashboards(projectSnapshot('analytics', [snapshot()]));
  assert.equal(renderDashboardYaml(placed, 'analytics'), GOLDEN_YAML);
});

test('H-6 — `spec.layout` is NOT emitted; a panel’s position is its gridPos, written once', () => {
  const [placed] = placeDashboards(projectSnapshot('analytics', [snapshot()]));
  const yaml = renderDashboardYaml(placed, 'analytics');
  assert.ok(!yaml.includes('layout:'), 'a second copy of gridPos would silently lose a hand edit');
  assert.match(yaml, /gridPos: \{ x: 0, y: 0, w: 8, h: 2 \}/, 'the position is still there, once');
});

test('H-6 — a file that still carries a layout block is ACCEPTED when it agrees', () => {
  const [placed] = placeDashboards(projectSnapshot('analytics', [snapshot()]));
  const withLayout = `${renderDashboardYaml(placed, 'analytics')}  layout:\n    items:\n      - { panel: p_revenue-over-time, x: 0, y: 0, w: 8, h: 2 }\n`;
  const parsed = parseDashboardFile(withLayout, 'dashboards/sales-overview/dashboard.yaml');
  assert.equal(parsed.panels[1].gridPos!.w, 8);
  // …and REFUSED when it disagrees, naming the panel, rather than being ignored.
  const conflicting = `${renderDashboardYaml(placed, 'analytics')}  layout:\n    items:\n      - { panel: p_revenue-over-time, x: 4, y: 0, w: 8, h: 2 }\n`;
  assert.throws(
    () => parseDashboardFile(conflicting, 'dashboards/sales-overview/dashboard.yaml'),
    /disagree|same fact written twice/,
  );
  // A layout naming a panel that does not exist is refused too.
  const orphan = `${renderDashboardYaml(placed, 'analytics')}  layout:\n    items:\n      - { panel: p_nope, x: 0, y: 0, w: 1, h: 1 }\n`;
  assert.throws(() => parseDashboardFile(orphan, 'dashboards/x/dashboard.yaml'), /not a panel in/);
});

test('the generated tree is exactly an index, one yaml and one README per dashboard', () => {
  const files = generateDashboardFiles(projectSnapshot('analytics', [snapshot()]));
  assert.deepEqual(
    [...files.keys()],
    ['dashboards/index.yml', 'dashboards/sales-overview/README.md', 'dashboards/sales-overview/dashboard.yaml'],
  );
  assert.ok(files.get('dashboards/index.yml')!.includes('id: dash_sales_overview_ab12cd'));
  assert.ok(files.get('dashboards/sales-overview/README.md')!.includes('# Sales Overview'));
});

test('an empty domain still commits the index, so the last removal is visible', () => {
  const files = generateDashboardFiles(projectSnapshot('analytics', []));
  assert.deepEqual([...files.keys()], [`${DASHBOARDS_PREFIX}index.yml`]);
  assert.ok(files.get(`${DASHBOARDS_PREFIX}index.yml`)!.includes('dashboards: []'));
});

test('generation is BYTE-STABLE: regenerating the same state changes nothing', () => {
  const once = generateDashboardFiles(projectSnapshot('analytics', [snapshot()]));
  const twice = generateDashboardFiles(projectSnapshot('analytics', [snapshotDashboard(stored, resolvers)]));
  assert.deepEqual([...twice.entries()], [...once.entries()]);
});

test('archived dashboards are excluded from the tree', () => {
  const archived = { ...snapshot(), archived: true };
  const files = generateDashboardFiles(projectSnapshot('analytics', [archived]));
  assert.deepEqual([...files.keys()], [`${DASHBOARDS_PREFIX}index.yml`]);
});

test('an unresolved member is written honestly, never given an invented id', () => {
  const snap = snapshotDashboard(stored, { viewRef: resolvers.viewRef }); // no memberRef at all
  const [placed] = placeDashboards(projectSnapshot('analytics', [snap]));
  const yaml = renderDashboardYaml(placed, 'analytics');
  assert.match(yaml, /- ref: unresolved\n {6}member: Orders\.revenue/);
  const sources = yaml.slice(yaml.indexOf('  sources:'), yaml.indexOf('  filters:'));
  assert.ok(!sources.includes('metric:'), `no metric id may be invented — got:\n${sources}`);
  assert.equal(placed.dashboard.panels[0].metrics[0].ref, null);
  const readme = generateDashboardFiles(projectSnapshot('analytics', [snap])).get('dashboards/sales-overview/README.md')!;
  assert.match(readme, /do not resolve to a governed metric id/);
  assert.match(readme, /\*\*\(unresolved\)\*\*/);
});

test('sources are deduplicated and the view comes first', () => {
  const sources = sourcesOf(snapshot());
  assert.equal(sources[0].ref, 'dataset:ds_orders_gold');
  assert.deepEqual(sources.map((s) => s.ref), [
    'dataset:ds_orders_gold',
    'metric:met_orders_revenue',
    'metric:met_orders_count',
  ]);
});

test('a lifecycle pin is recorded when one exists, and the file says nothing when it does not', () => {
  const pinned = snapshotDashboard(stored, { ...resolvers, lifecycle: () => ({ draft: 'abc1234', live: 'live/dashboard/dash_sales_overview_ab12cd' }) });
  const [placed] = placeDashboards(projectSnapshot('analytics', [pinned]));
  const yaml = renderDashboardYaml(placed, 'analytics');
  assert.match(yaml, /lifecycle:/);
  assert.match(yaml, /live: live\/dashboard\/dash_sales_overview_ab12cd/);
  assert.ok(!GOLDEN_YAML.includes('lifecycle:'), 'no pin ⇒ no lifecycle block, never an invented one');
});

// ------------------------------------------------------------------ round trip ---

test('D9 — generate → read → generate is BYTE-STABLE', () => {
  const [placed] = placeDashboards(projectSnapshot('analytics', [snapshot()]));
  const first = renderDashboardYaml(placed, 'analytics');
  const parsed = parseDashboardFile(first, 'dashboards/sales-overview/dashboard.yaml');
  const [replaced] = placeDashboards(projectSnapshot('analytics', [parsed]));
  assert.equal(renderDashboardYaml(replaced, 'analytics'), first);
});

test('D9 — the parse recovers every field, including the governed ids', () => {
  const [placed] = placeDashboards(projectSnapshot('analytics', [snapshot()]));
  const parsed = parseDashboardFile(renderDashboardYaml(placed, 'analytics'));
  assert.equal(parsed.id, stored.id);
  assert.equal(parsed.name, 'Sales Overview');
  assert.equal(parsed.view, 'Orders');
  assert.equal(parsed.tier, 'domain');
  assert.equal(parsed.folder, '/weekly');
  assert.equal(parsed.viewRef, 'dataset:ds_orders_gold');
  assert.equal(parsed.panels.length, 3);
  assert.deepEqual(parsed.panels[1].metrics, [
    { member: 'Orders.revenue', ref: 'metric:met_orders_revenue' },
    { member: 'Orders.order_count', ref: 'metric:met_orders_count' },
  ]);
  assert.deepEqual(parsed.panels[1].gridPos, { x: 0, y: 0, w: 8, h: 2 });
  assert.deepEqual(parsed.panels[2].filters, [{ member: 'Orders.channel', operator: 'in', values: ['web', 'retail'] }]);
  assert.deepEqual(parsed.filters, [{ member: 'Orders.region', operator: 'equals', values: ['DE'] }]);
  assert.equal(ownerRef(parsed), ownerToken(OWNER), 'the owner token must survive the round trip un-rehashed');
});

test('D9 — a HAND-EDITED file imports (an engineer may author one from scratch)', () => {
  const handWritten = `apiVersion: os.sovereign/v1
kind: Dashboard
metadata:
  id: dash_hand_1
  name: My hand-written board
  owner: fc4a050fe512
  tier: personal
spec:
  view: Orders
  sources:
    - ref: metric:met_orders_revenue
      member: Orders.revenue
  panels:
    - id: p_rev
      name: Revenue
      viz: big_number
      metrics: [Orders.revenue]
`;
  const doc = parseDashboardFile(handWritten, 'dashboards/personal/x/hand/dashboard.yaml');
  assert.equal(doc.id, 'dash_hand_1');
  const spec = importDashboard(doc, (ref) => (ref === 'metric:met_orders_revenue' ? { member: 'Orders.revenue' } : null));
  assert.deepEqual(spec, { name: 'My hand-written board', view: 'Orders', charts: [{ name: 'Revenue', vizType: 'big_number', metrics: ['Orders.revenue'] }] });
});

// -------------------------------------------------------------------- refusals ---

function refusal(text: string): string {
  try {
    const doc = parseDashboardFile(text, 'dashboards/x/dashboard.yaml');
    importDashboard(doc, () => null);
    return '(accepted)';
  } catch (e) {
    assert.ok(e instanceof DashboardFileError, `expected a typed DashboardFileError, got ${String(e)}`);
    assert.equal((e as DashboardFileError).status, 400);
    return (e as Error).message;
  }
}

const MINIMAL = `apiVersion: os.sovereign/v1
kind: Dashboard
metadata: { id: d1, name: D, owner: fc4a050fe512, tier: personal }
spec:
  view: Orders
  sources: [{ ref: 'metric:m1', member: Orders.revenue }]
  panels: [{ id: p1, name: P, viz: bar, metrics: [Orders.revenue] }]
`;

test('a good minimal file is accepted', () => {
  const doc = parseDashboardFile(MINIMAL);
  assert.deepEqual(
    importDashboard(doc, () => ({ member: 'Orders.revenue' })),
    { name: 'D', view: 'Orders', charts: [{ name: 'P', vizType: 'bar', metrics: ['Orders.revenue'] }] },
  );
});

test('D-R3.4 — a missing governed id FAILS LOUDLY, naming the id', () => {
  const msg = refusal(MINIMAL);
  assert.match(msg, /does not exist in this domain/);
  assert.match(msg, /metric:m1/);
  assert.match(msg, /never silently rebound/);
});

test('D-R3.3 — a `sql:`-shaped key anywhere in spec is REFUSED', () => {
  const smuggles: [string, string][] = [
    ['spec.sql', MINIMAL.replace('  view: Orders', '  view: Orders\n  sql: SELECT 1')],
    ['spec.query', MINIMAL.replace('  view: Orders', '  view: Orders\n  query: SELECT 1')],
    ['a panel', MINIMAL.replace('metrics: [Orders.revenue] }]', "metrics: [Orders.revenue], sql: 'SELECT 1' }]")],
    ['a source', MINIMAL.replace("member: Orders.revenue }]", "member: Orders.revenue, datasource: raw }]")],
    ['nested', MINIMAL.replace('  view: Orders', "  view: Orders\n  time: { expression: 'now() - 7' }")],
  ];
  for (const [label, text] of smuggles) {
    const msg = refusal(text);
    assert.match(msg, /is not a field of this format/, label);
    assert.match(msg, /GOVERNED METRIC MEMBERS/, label);
  }
});

test('a wrong apiVersion, kind, tier or viz is refused by name', () => {
  assert.match(refusal(MINIMAL.replace('os.sovereign/v1', 'os.sovereign/v2')), /apiVersion. is .os\.sovereign\/v2/);
  assert.match(refusal(MINIMAL.replace('kind: Dashboard', 'kind: Chart')), /`kind` must be `Dashboard`/);
  assert.match(refusal(MINIMAL.replace('tier: personal', 'tier: secret')), /metadata\.tier` must be one of/);
  assert.match(refusal(MINIMAL.replace('viz: bar', 'viz: sankey')), /viz` is .sankey/);
});

test('an unservable filter operator is refused at PARSE time, before anything is imported', () => {
  const msg = refusal(MINIMAL.replace('metrics: [Orders.revenue] }]', "metrics: [Orders.revenue], filters: [{ member: a, operator: '>=', values: ['1'] }] }]"));
  assert.match(msg, /cannot serve/);
  assert.match(msg, /only `equals` and `in` are servable/);
});

test('a bogus ref shape, a panel with no metrics, and invalid YAML are each named', () => {
  assert.match(refusal(MINIMAL.replace("'metric:m1'", "'select * from t'")), /must be a stable OS id/);
  assert.match(refusal(MINIMAL.replace('metrics: [Orders.revenue] }]', 'metrics: [] }]')), /must name at least one governed member/);
  assert.match(refusal('this: is: not: yaml:'), /not valid YAML/);
  assert.match(refusal('[]'), /must be a YAML mapping/);
});

test('every refusal names the FILE, so a developer’s terminal is actionable', () => {
  try {
    parseDashboardFile('kind: Dashboard', 'dashboards/sales-overview/dashboard.yaml');
    assert.fail('should have thrown');
  } catch (e) {
    assert.match((e as Error).message, /^dashboards\/sales-overview\/dashboard\.yaml: /);
  }
});
