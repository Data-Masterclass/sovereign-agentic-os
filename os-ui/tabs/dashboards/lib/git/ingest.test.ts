/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The `ingestFromRepo('dashboard', files)` contract stream E calls (D29)
 * USER STORY: As an engineer I want a push that references a metric my domain does not have to be
 *             REFUSED on the terminal, naming the file and the id — and a good push to apply.
 * ARCHITECTURE: Pure; a synthetic pushed file map in, a typed plan out. No git, no store, no route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INGEST_KIND,
  ingestAccepted,
  ingestFromRepo,
  ingestRefusalMessage,
  isDashboardFile,
  isGeneratedDashboardFile,
} from '@tabs/dashboards/lib/git/ingest';

const GOOD = `apiVersion: os.sovereign/v1
kind: Dashboard
metadata: { id: dash_1, name: Sales Overview, owner: fc4a050fe512, tier: domain }
spec:
  view: Orders
  sources: [{ ref: 'metric:met_rev', member: Orders.revenue }]
  panels: [{ id: p_rev, name: Revenue, viz: big_number, metrics: [Orders.revenue] }]
`;

const resolveAll = () => ({ member: 'Orders.revenue' });
const resolveNone = () => null;

test('only `dashboards/**/dashboard.yaml` is input; the generated files are ignored', () => {
  assert.equal(isDashboardFile('dashboards/sales-overview/dashboard.yaml'), true);
  assert.equal(isDashboardFile('dashboards/personal/abc/mine/dashboard.yaml'), true);
  assert.equal(isDashboardFile('dashboards/index.yml'), false);
  assert.equal(isDashboardFile('models/semantic/orders.yml'), false);
  assert.equal(isGeneratedDashboardFile('dashboards/index.yml'), true);
  assert.equal(isGeneratedDashboardFile('dashboards/sales-overview/README.md'), true);
  assert.equal(isGeneratedDashboardFile('dashboards/sales-overview/dashboard.yaml'), false);
});

test('a good push yields one dashboard to apply, with every id resolved', () => {
  const plan = ingestFromRepo(
    INGEST_KIND,
    new Map([
      ['dashboards/sales-overview/dashboard.yaml', GOOD],
      ['dashboards/index.yml', 'version: 1'],
      ['dashboards/sales-overview/README.md', '# generated'],
      ['models/semantic/orders.yml', 'metrics: []'],
    ]),
    resolveAll,
  );
  assert.ok(ingestAccepted(plan));
  assert.equal(plan.dashboards.length, 1);
  assert.equal(plan.dashboards[0].id, 'dash_1');
  assert.equal(plan.dashboards[0].file, 'dashboards/sales-overview/dashboard.yaml');
  assert.equal(plan.files, 1);
  assert.equal(plan.emptied, false);
  assert.deepEqual(plan.dashboards[0].spec, {
    name: 'Sales Overview',
    view: 'Orders',
    charts: [{ name: 'Revenue', vizType: 'big_number', metrics: ['Orders.revenue'] }],
  });
  // The OS GENERATES index.yml and README.md, so a hand edit to them is ignored, not honoured.
  assert.deepEqual(plan.ignored.sort(), ['dashboards/index.yml', 'dashboards/sales-overview/README.md']);
  assert.equal(ingestRefusalMessage(plan), '');
});

test('D-R3.4 — a reference this domain does not have REFUSES the push, naming file and id', () => {
  const plan = ingestFromRepo(INGEST_KIND, new Map([['dashboards/sales-overview/dashboard.yaml', GOOD]]), resolveNone);
  assert.equal(ingestAccepted(plan), false);
  assert.equal(plan.dashboards.length, 0, 'nothing is applied when anything is refused');
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0].reason, /dashboards\/sales-overview\/dashboard\.yaml/);
  assert.match(plan.rejected[0].reason, /metric:met_rev/);
  const msg = ingestRefusalMessage(plan);
  assert.match(msg, /Rejected: 1 dashboard file the OS cannot accept/);
  assert.match(msg, /Nothing was applied/);
});

test('one bad file does not hide the others — every refusal is reported', () => {
  const plan = ingestFromRepo(
    INGEST_KIND,
    new Map([
      ['dashboards/a/dashboard.yaml', GOOD],
      ['dashboards/b/dashboard.yaml', 'kind: Dashboard'],
      ['dashboards/c/dashboard.yaml', GOOD.replace('viz: big_number', 'viz: sankey')],
    ]),
    resolveAll,
  );
  assert.equal(plan.dashboards.length, 1, 'the good one is still planned');
  assert.deepEqual(plan.rejected.map((r) => r.file), ['dashboards/b/dashboard.yaml', 'dashboards/c/dashboard.yaml']);
  assert.equal(ingestAccepted(plan), false, 'E refuses the whole push');
  assert.match(ingestRefusalMessage(plan), /Rejected: 2 dashboard files/);
});

test('a push with no dashboard files is an empty, accepted plan', () => {
  const plan = ingestFromRepo(INGEST_KIND, new Map([['models/orders.sql', 'select 1']]), resolveAll);
  assert.deepEqual(plan, { kind: 'dashboard', dashboards: [], rejected: [], ignored: [], files: 0, emptied: false });
  assert.equal(ingestAccepted(plan), true);
});

test('the wrong kind is a loud programming error, not a silent no-op', () => {
  assert.throws(() => ingestFromRepo('metric', new Map(), resolveAll), /handles kind 'dashboard'/);
});

test('the plan carries the parsed doc, so E can record the lifecycle pin', () => {
  const withPin = GOOD.replace(
    'metadata: { id: dash_1, name: Sales Overview, owner: fc4a050fe512, tier: domain }',
    'metadata:\n  id: dash_1\n  name: Sales Overview\n  owner: fc4a050fe512\n  tier: domain\n  lifecycle: { live: v1.2.0 }',
  );
  const plan = ingestFromRepo(INGEST_KIND, new Map([['dashboards/a/dashboard.yaml', withPin]]), resolveAll);
  assert.deepEqual(plan.dashboards[0].doc.lifecycle, { live: 'v1.2.0' });
});

// ------------------------------------------- stream G's resolver contract (D24) ---

test('G — the resolver locates the dashboard’s directory AND the shared index', async () => {
  const { dashboardPaths, resolveDashboardGitObject, GIT_OBJECT_KIND } = await import('@tabs/dashboards/lib/git/git-object');
  assert.equal(GIT_OBJECT_KIND, 'dashboard');
  assert.deepEqual(dashboardPaths('dashboards/sales-overview'), ['dashboards/sales-overview/', 'dashboards/index.yml']);
  const user = { id: 'alex@datamasterclass.com', domains: ['analytics'], role: 'creator' as const };
  const rec = {
    id: 'dash_1',
    owner: user.id,
    tier: 'domain' as const,
    domain: 'analytics',
    spec: { name: 'Sales Overview', view: 'Orders', charts: [{ name: 'R', vizType: 'bar' as const, metrics: ['Orders.revenue'] }] },
  };
  assert.deepEqual(resolveDashboardGitObject(user, 'dash_1', () => rec), {
    domain: 'analytics',
    paths: ['dashboards/sales-overview/', 'dashboards/index.yml'],
    trailerId: 'dash_1',
    name: 'Sales Overview',
  });
  // A personal dashboard resolves to the owner's opaque lane, not to a path naming the person.
  const personal = resolveDashboardGitObject(user, 'dash_1', () => ({ ...rec, tier: 'personal' as const }));
  assert.match(personal!.paths[0], /^dashboards\/personal\/[0-9a-f]{12}\/sales-overview\/$/);
  assert.ok(!personal!.paths[0].includes(user.id));
});

test('G5 — an invisible or missing dashboard resolves to null, indistinguishably', async () => {
  const { resolveDashboardGitObject } = await import('@tabs/dashboards/lib/git/git-object');
  const user = { id: 'u', domains: ['analytics'], role: 'creator' as const };
  // The store throws 403 for an invisible one and 404 for a missing one; both are null here, so
  // the generic git read cannot be used to probe for someone else's dashboard.
  assert.equal(
    resolveDashboardGitObject(user, 'dash_other', () => {
      throw Object.assign(new Error('not authorized'), { status: 403 });
    }),
    null,
  );
  assert.equal(
    resolveDashboardGitObject(user, 'nope', () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    }),
    null,
  );
  // A dashboard with no domain has no repository, so there is nothing to locate.
  assert.equal(
    resolveDashboardGitObject(user, 'dash_1', () => ({
      id: 'dash_1',
      owner: 'u',
      tier: 'personal' as const,
      domain: '',
      spec: { name: 'X', view: 'Orders', charts: [] },
    })),
    null,
  );
});

// --------------------------------------- H-8: the audience ladder is never pushable ---

test('H-8 — the plan carries NO tier: a push can never change a dashboard’s audience', () => {
  const marketplace = GOOD.replace('tier: domain', 'tier: marketplace');
  const plan = ingestFromRepo(INGEST_KIND, new Map([['dashboards/a/dashboard.yaml', marketplace]]), resolveAll);
  assert.ok(ingestAccepted(plan), 'the file is still VALID — the tier is read and shape-checked');
  const applied = plan.dashboards[0] as Record<string, unknown>;
  assert.ok(!('tier' in applied), 'a `tier` on the plan would let a creator publish company-wide with no approver');
  // The parsed doc still carries it, for the record and for the round trip — it is just not
  // authority, and nothing downstream may read it as such.
  assert.equal(plan.dashboards[0].doc.tier, 'marketplace');
  // A nonsense tier is still refused, so a typo is caught rather than imported.
  const bogus = GOOD.replace('tier: domain', 'tier: company-wide');
  const refused = ingestFromRepo(INGEST_KIND, new Map([['dashboards/a/dashboard.yaml', bogus]]), resolveAll);
  assert.equal(ingestAccepted(refused), false);
  assert.match(refused.rejected[0].reason, /metadata\.tier` must be one of/);
});

// ------------------------- H-7: a push that would empty the subtree is refused ---

test('H-7 — a push that removes every dashboard.yaml is reported as `emptied` and REFUSED', () => {
  // The tree still touches `dashboards/` (the index is there) but carries no dashboard.yaml, so
  // applying it would delete every dashboard in the domain. Almost always a forgotten path.
  const plan = ingestFromRepo(INGEST_KIND, new Map([['dashboards/index.yml', 'version: 1\ndashboards: []\n']]), resolveAll);
  assert.equal(plan.files, 0);
  assert.equal(plan.emptied, true);
  assert.equal(ingestAccepted(plan), false, 'E must be able to refuse this');
  assert.match(ingestRefusalMessage(plan), /would delete every dashboard in this domain/);
  assert.match(ingestRefusalMessage(plan), /Nothing was applied/);
  // A caller that really means it, after its own confirmation, can still proceed.
  assert.equal(ingestAccepted(plan, { allowEmptying: true }), true);
});

test('H-7 — a push that does not touch `dashboards/` at all is NOT an emptying', () => {
  const plan = ingestFromRepo(INGEST_KIND, new Map([['models/orders.sql', 'select 1']]), resolveAll);
  assert.equal(plan.emptied, false, 'a dbt-only push must not look like a dashboard deletion');
  assert.equal(ingestAccepted(plan), true);
});

test('H-1 — an injected time grain is refused at the PUSH door too', () => {
  const injected = GOOD.replace(
    'panels: [{ id: p_rev, name: Revenue, viz: big_number, metrics: [Orders.revenue] }]',
    "panels: [{ id: p_rev, name: Revenue, viz: line, metrics: [Orders.revenue], timeDimension: Orders.d, timeGrain: \"month'), (SELECT password FROM users) --\" }]",
  );
  const plan = ingestFromRepo(INGEST_KIND, new Map([['dashboards/a/dashboard.yaml', injected]]), resolveAll);
  assert.equal(ingestAccepted(plan), false);
  assert.match(plan.rejected[0].reason, /timeGrain/);
  assert.match(plan.rejected[0].reason, /not a grain the governed query path can serve/);
  assert.match(plan.rejected[0].reason, /allow-listed rather than escaped/);
});

// ------------------------------- H-3: slug is not id, and facts.ts knows it ---

test('H-3 — pathsForDashboard resolves the slug through the committed index, not from the id', async () => {
  const { pathsForDashboard, parseDashboardIndex, indexEntryFor, yamlPathForDashboard } = await import('@tabs/dashboards/lib/git/facts');
  const indexYaml = [
    'version: 1',
    'domain: analytics',
    'dashboards:',
    '  - slug: sales-overview',
    '    id: dash_sales_overview_ab12cd',
    '    path: dashboards/sales-overview',
    '    name: Sales Overview',
  ].join('\n');
  assert.equal(parseDashboardIndex(indexYaml).length, 1);
  assert.equal(indexEntryFor(parseDashboardIndex(indexYaml), 'dash_sales_overview_ab12cd')!.slug, 'sales-overview');
  // The id is NOT the directory name — a caller that guessed `dashboards/<id>/` would be wrong.
  assert.deepEqual(pathsForDashboard('dash_sales_overview_ab12cd', { indexYaml }), [
    'dashboards/sales-overview/',
    'dashboards/index.yml',
  ]);
  assert.equal(yamlPathForDashboard('dash_sales_overview_ab12cd', { indexYaml }), 'dashboards/sales-overview/dashboard.yaml');
  // No index and no record ⇒ null, which is honest; a guessed path would make `git log` empty.
  assert.equal(pathsForDashboard('dash_x', { indexYaml }), null);
  assert.equal(pathsForDashboard('dash_x', {}), null);
  // A malformed index degrades to the record, never to an error (it is a generated convenience).
  assert.deepEqual(parseDashboardIndex('not: [valid'), []);
  assert.deepEqual(
    pathsForDashboard('dash_1', {
      indexYaml: 'garbage',
      record: { id: 'dash_1', owner: 'u', tier: 'domain', domain: 'analytics', spec: { name: 'Sales Overview', view: 'Orders', charts: [] } },
    }),
    ['dashboards/sales-overview/', 'dashboards/index.yml'],
  );
});
