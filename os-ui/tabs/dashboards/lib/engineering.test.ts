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
  spec: { name: 'Revenue', view: 'Orders', charts: [{ name: 'Revenue by month', vizType: 'line', metrics: ['ds_1.revenue'] }] },
};

let paths: string[] = ['dashboards/dash_1.yml'];

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
    readRepoFiles: async () => ({ repo: 'ops', head: 'beef', files: paths.map((p) => ({ path: p, content: CODE })), unreadable: [], reason: null }),
  },
});

const { dashboardEngineeringView, dashboardPaths, DASHBOARD_DIR } = await import('@tabs/dashboards/lib/engineering');
const USER = { id: 'amir', name: 'Amir', domains: ['ops'], allDomains: ['ops'], activeDomain: 'ops', role: 'admin' } as unknown as EngineeringPrincipal;
const OUTSIDER = { id: 'fiona', name: 'Fiona', domains: ['finance'], allDomains: ['finance'], activeDomain: 'finance', role: 'admin' } as unknown as EngineeringPrincipal;

test('the dashboard-as-code path of one dashboard is selected from the reserved subtree', () => {
  assert.deepEqual(dashboardPaths(['dashboards/dash_1.yml', 'dashboards/dash_2.yml'], 'dash_1'), ['dashboards/dash_1.yml']);
  assert.equal(DASHBOARD_DIR, 'dashboards/');
});

test('T6: the git section shows the committed dashboard-as-code file and its path', async () => {
  const view = await dashboardEngineeringView(USER, 'dash_1');
  assert.deepEqual(vocabularyViolations(view), []);
  const git = view.sections.find((s) => s.tool === 'git');
  assert.equal(git?.artefacts[0].repoPath, 'dashboards/dash_1.yml');
  assert.equal(git?.artefacts[0].body, CODE);
  assert.equal(view.export?.href, '/api/data/projects/ops/blob?path=dashboards%2Fdash_1.yml');
  // M-4: the export label leads with the tool's noun.
  assert.equal(view.export?.tool, 'git');
  assert.match(view.export?.label ?? '', /^git file/);
});

test('T3/T7: the dbt section names the metrics the panels query and gives the MetricFlow command', async () => {
  const view = await dashboardEngineeringView(USER, 'dash_1');
  const dbt = view.sections.find((s) => s.tool === 'dbt');
  assert.match(dbt?.unavailable ?? '', /ds_1\.revenue/);
  assert.ok((dbt?.caveats ?? []).some((c) => /signed-in user/.test(c)));
});

test('T7: with nothing committed, the export says which file is missing instead of offering a broken link', async () => {
  paths = [];
  const view = await dashboardEngineeringView(USER, 'dash_1');
  assert.equal(view.export?.href, null);
  assert.match(view.export?.unresolvedReason ?? '', /dashboards\/dash_1\.yml/);
  const git = view.sections.find((s) => s.tool === 'git');
  assert.match(git?.unavailable ?? '', /lands it at/);
  paths = ['dashboards/dash_1.yml'];
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
