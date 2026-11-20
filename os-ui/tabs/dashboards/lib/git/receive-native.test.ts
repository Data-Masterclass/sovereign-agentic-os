/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    WP-52 — the receive gate validates pushed native dashboard files
 * USER STORY: As an engineer who hand-edits a Vega-Lite spec or a saved query and pushes it, I want
 *             a broken file refused by name at push time, and a good one accepted.
 * ARCHITECTURE:
 *   - The gate's per-file validator only; the directory-level check is the reader (native.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARDS_NATIVE = 'true';
const { matchesDashboard, validateDashboardFile, isNativeDashboardFile } = await import('@tabs/dashboards/lib/git/receive');

const D = 'dashboards/sales-overview';
const vl = { $schema: 'https://vega.github.io/schema/vega-lite/v5.json', data: { name: 'q' }, mark: { type: 'bar' }, encoding: {} };

test('with the flag on, the native files of a dashboard directory belong to the dashboard kind', () => {
  for (const p of [`${D}/os.yaml`, `${D}/semantic.yml`, `${D}/panels/p_x.vl.json`]) {
    assert.ok(isNativeDashboardFile(p), p);
    assert.ok(matchesDashboard(p), p);
  }
  assert.equal(matchesDashboard(`${D}/README.md`), false);
});

test('a valid spec passes; an OS block, a bad schema or a foreign semantic key is refused by name', () => {
  assert.equal(validateDashboardFile({ path: `${D}/panels/p_x.vl.json`, content: JSON.stringify(vl) }), null);
  assert.match(validateDashboardFile({ path: `${D}/panels/p_x.vl.json`, content: JSON.stringify({ ...vl, os: {} }) }) ?? '', /`os`/);
  assert.match(validateDashboardFile({ path: `${D}/panels/p_x.vl.json`, content: JSON.stringify({ ...vl, $schema: 'x' }) }) ?? '', /\$schema/);
  assert.match(validateDashboardFile({ path: `${D}/semantic.yml`, content: 'version: 2\nmodels: []\n' }) ?? '', /models/);
  assert.equal(validateDashboardFile({ path: `${D}/semantic.yml`, content: 'version: 2\nsaved_queries: []\n' }), null);
  assert.match(validateDashboardFile({ path: `${D}/os.yaml`, content: 'apiVersion: x\n' }) ?? '', /DashboardLayer/);
});
