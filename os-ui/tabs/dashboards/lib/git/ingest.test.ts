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
  assert.equal(plan.dashboards[0].tier, 'domain');
  assert.equal(plan.dashboards[0].file, 'dashboards/sales-overview/dashboard.yaml');
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
  assert.deepEqual(plan, { kind: 'dashboard', dashboards: [], rejected: [], ignored: [] });
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
