/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The dashboard engineering view — the dashboard-as-code file, and the dbt metrics it queries
 * USER STORY: As a reviewer I want the dashboard's panel to show the committed dashboard-as-code
 *             file with its path, and to name the dbt metrics each panel queries rather than
 *             inventing a dashboard artefact of our own (checklist T1, T3, T6, T7).
 * ARCHITECTURE:
 *   - Pure: the store and the repository reader are module-mocked; `panelMetrics` is the tab's own.
 *   - NIGHT-2 MERGE (T x D): the fixture now uses the REAL dashboard-as-code layout. The directory
 *     is slugged from the dashboard's NAME, so it is `dashboards/revenue/dashboard.yaml`, not the
 *     guessed `dashboards/dash_1.yml`, and the committed `dashboards/index.yml` is the mapping the
 *     adapter prefers. Both are D's `lib/git/facts.ts`.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyViolations } from '@core/engineering/vocabulary';
import type { EngineeringPrincipal } from '@core/engineering/types';

const CODE = "name: Revenue\nview: Orders\ncharts:\n  - { name: Revenue by month, vizType: line, metrics: [ds_1.revenue] }\n";
const RECORD = {
  id: 'dash_1',
  domain: 'ops',
  owner: 'amir',
  tier: 'Domain',
  spec: { name: 'Revenue', view: 'Orders', charts: [{ name: 'Revenue by month', vizType: 'line', metrics: ['ds_1.revenue'] }] },
};

/** The real layout: slug != id, so the directory is slugged from the NAME. */
const DIR = 'dashboards/revenue';
const YAML_PATH = `${DIR}/dashboard.yaml`;
const INDEX_PATH = 'dashboards/index.yml';
const INDEX = `dashboards:\n  - slug: revenue\n    id: dash_1\n    path: ${DIR}\n    name: Revenue\n`;

let paths: string[] = [INDEX_PATH, YAML_PATH];

mock.module('@tabs/dashboards/lib/store', {
  namedExports: {
    getDashboard: (id: string) => {
      if (id !== RECORD.id) { const e = new Error('Dashboard not found') as Error & { status?: number }; e.status = 404; throw e; }
      return RECORD;
    },
  },
});
mock.module('@core/engineering/repo', {
  namedExports: {
    repoPaths: async () => ({ repo: 'ops', head: 'beef', paths, reason: null }),
    readRepoFiles: async (_repo: string, want: (p: string) => boolean) => ({
      repo: 'ops',
      head: 'beef',
      files: paths.filter(want).map((p) => ({ path: p, content: p === INDEX_PATH ? INDEX : CODE })),
      unreadable: [],
      reason: null,
    }),
  },
});

const { dashboardEngineeringView, dashboardPaths, DASHBOARD_DIR } = await import('@tabs/dashboards/lib/engineering');
const USER = { id: 'amir', name: 'Amir', domains: ['ops'], allDomains: ['ops'], activeDomain: 'ops', role: 'admin' } as unknown as EngineeringPrincipal;
const OUTSIDER = { id: 'fiona', name: 'Fiona', domains: ['finance'], allDomains: ['finance'], activeDomain: 'finance', role: 'admin' } as unknown as EngineeringPrincipal;

test('the dashboard-as-code path of one dashboard is resolved through the committed index, not guessed', () => {
  assert.equal(DASHBOARD_DIR, 'dashboards/');
  const tracked = [INDEX_PATH, YAML_PATH, 'dashboards/other/dashboard.yaml'];
  // The index is the mapping: id -> slugged directory. Only THIS dashboard's directory comes back.
  assert.deepEqual(dashboardPaths(tracked, 'dash_1', { indexYaml: INDEX }), [YAML_PATH]);
  // A dashboard nothing can locate is an EMPTY list, never a guessed `dashboards/<id>.yml`.
  assert.deepEqual(dashboardPaths(tracked, 'dash_unknown', { indexYaml: INDEX }), []);
  // With no index, the placement is recomputed from the record — and it is still the slug.
  assert.deepEqual(dashboardPaths(tracked, 'dash_1', { record: RECORD as never, indexYaml: null }), [YAML_PATH]);
});

test('T6: the git section shows the committed dashboard-as-code file and its path', async () => {
  const view = await dashboardEngineeringView(USER, 'dash_1');
  assert.deepEqual(vocabularyViolations(view), []);
  const git = view.sections.find((s) => s.tool === 'git');
  assert.equal(git?.artefacts[0].repoPath, YAML_PATH);
  assert.equal(git?.artefacts[0].body, CODE);
  assert.equal(view.export?.href, `/api/data/projects/ops/blob?path=${encodeURIComponent(YAML_PATH)}`);
  // D's facts are ported in: git's own commands against the REAL path, and the live-pin line.
  assert.ok(git?.commands.some((c) => c.command === `git log --stat -- ${YAML_PATH}`), 'D\'s gitCommands are present');
  assert.ok((git?.caveats ?? []).some((c) => /Live pinned commit: no version pinned\./.test(c)), 'the unwired lifecycle port reads as "nothing pinned", with the reason');
  // M-4: the export label leads with the tool's noun.
  assert.equal(view.export?.tool, 'git');
  assert.match(view.export?.label ?? '', /^git file/);
});

test('T3/T7: the dbt section names the metrics the panels query and gives the MetricFlow command', async () => {
  const view = await dashboardEngineeringView(USER, 'dash_1');
  const dbt = view.sections.find((s) => s.tool === 'dbt');
  assert.match(dbt?.unavailable ?? '', /ds_1\.revenue/);
  assert.ok((dbt?.caveats ?? []).some((c) => /signed-in user/.test(c)));
  // NIGHT-2 MERGE: D's `governedRefs` are ported in — a member nothing governed owns is NAMED,
  // never dropped, because the panel still charts it.
  assert.ok((dbt?.caveats ?? []).some((c) => /Governed references:/.test(c)), 'D\'s governed refs are reported');
  assert.ok((dbt?.caveats ?? []).some((c) => /No dbt metric owns .*ds_1\.revenue/.test(c)), 'an unresolved member is named');
  assert.ok((dbt?.caveats ?? []).some((c) => /not importable by Superset/.test(c)), 'D\'s honesty caveats survive');
});

test('T7: with nothing committed, the export says which file is missing instead of offering a broken link', async () => {
  // The index is committed, the dashboard's own directory is not.
  paths = [INDEX_PATH];
  const view = await dashboardEngineeringView(USER, 'dash_1');
  assert.equal(view.export?.href, null);
  assert.match(view.export?.unresolvedReason ?? '', /dashboards\/revenue\/dashboard\.yaml/);
  const git = view.sections.find((s) => s.tool === 'git');
  assert.match(git?.unavailable ?? '', /lands it at/);
  assert.equal(git?.artefacts.length, 0, 'an unavailable section carries NO artefact (T7)');
  paths = [INDEX_PATH, YAML_PATH];
});

test('T7: a dashboard that does not exist is the tab\'s own 404', async () => {
  await assert.rejects(() => dashboardEngineeringView(USER, 'dash_missing'), (e: Error & { status?: number }) => e.status === 404);
});

test('H-1/M-1: a dashboard shared beyond its domain shows no committed file and no export to a non-member', async () => {
  const view = await dashboardEngineeringView(OUTSIDER, 'dash_1');
  assert.deepEqual(vocabularyViolations(view), []);
  const git = view.sections.find((s) => s.tool === 'git');
  assert.equal(git?.artefacts.length, 0);
  assert.match(git?.unavailable ?? '', /members-only/);
  assert.equal(view.export?.href, null);
  assert.match(view.export?.unresolvedReason ?? '', /members-only/);
});
