/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 — saving a dashboard COMMITS the saved queries + Vega-Lite specs, and the OS reads them back
 * USER STORY: As a user I want a dashboard save to land in my domain's repo as dbt and Vega-Lite files
 *             bound to the metrics committed there, and the dashboard I open to be read from them.
 * ARCHITECTURE:
 *   - A REAL git repository (the git store in a temp dir). The dbt YAML is committed first, as the
 *     data tab does; `commitDashboards` reads it from `main` to bind the panels.
 *   - Flag off ⇒ the legacy `dashboard.yaml` is written, unchanged (the negative twin).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTree, listTree } from '@core/infra/git-store';
import { commitDashboards, __setDashboardProjectGitForTests } from '@tabs/dashboards/lib/git/commit';
import { nativeSpecForView } from '@tabs/dashboards/lib/git/native-git';
import { snapshotDashboard } from '@tabs/dashboards/lib/git/snapshot';

const reposDir = mkdtempSync(join(tmpdir(), 'wp52-commit-'));
after(() => rmSync(reposDir, { recursive: true, force: true }));
__setDashboardProjectGitForTests(true);
const golden = JSON.parse(readFileSync(new URL('../../../data/lib/dbt/fixtures/metrics-semantic-layer.golden.json', import.meta.url), 'utf8')) as Record<string, string>;
const V = 'sales__Orders';
const dash = snapshotDashboard({
  id: 'dash_c1', owner: 'amir', tier: 'domain', domain: 'sales', folder: '/',
  spec: { name: 'Sales', view: V, charts: [{ name: 'Revenue by region', vizType: 'bar', metrics: [`${V}.revenue`], dimensions: [`${V}.region`] }] },
});
const actor = { id: 'amir', name: 'Amir', email: 'amir@os.local' };

test('flag ON: the save commits semantic.yml + a .vl.json bound to the committed metrics, and the OS draws it back', async () => {
  await commitTree('sales', new Map(Object.entries(golden)), { author: { name: 'os', email: 'os@os.local' }, message: 'dbt', reposDir });
  process.env.DASHBOARDS_NATIVE = 'true';
  try {
    const r = await commitDashboards('sales', actor, { action: 'create dashboard' }, { reposDir, captured: [dash], mirror: false });
    assert.ok(r?.changed);
    const paths = (await listTree('sales', 'main', { reposDir })).map((e) => e.path).filter((p) => p.startsWith('dashboards/'));
    assert.deepEqual(paths.sort(), ['dashboards/index.yml', 'dashboards/sales/README.md', 'dashboards/sales/os.yaml', 'dashboards/sales/panels/p_revenue-by-region.vl.json', 'dashboards/sales/semantic.yml']);
    const v = await nativeSpecForView('sales', 'dash_c1', { reposDir });
    assert.ok(!('unavailable' in v));
    assert.deepEqual(v.spec.charts, [{ name: 'Revenue by region', vizType: 'bar', metrics: [`${V}.revenue`], dimensions: [`${V}.region`] }]);
  } finally {
    delete process.env.DASHBOARDS_NATIVE;
  }
});

test('NEGATIVE TWIN: flag OFF writes the legacy dashboard.yaml, and the native reader finds nothing to draw', async () => {
  const other = mkdtempSync(join(tmpdir(), 'wp52-commit-off-'));
  try {
    await commitTree('sales', new Map(Object.entries(golden)), { author: { name: 'os', email: 'os@os.local' }, message: 'dbt', reposDir: other });
    await commitDashboards('sales', actor, { action: 'create dashboard' }, { reposDir: other, captured: [dash], mirror: false });
    const paths = (await listTree('sales', 'main', { reposDir: other })).map((e) => e.path);
    assert.ok(paths.includes('dashboards/sales/dashboard.yaml'));
    assert.ok(!paths.some((p) => p.endsWith('.vl.json')));
    const v = await nativeSpecForView('sales', 'dash_c1', { reposDir: other });
    assert.ok('unavailable' in v);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
