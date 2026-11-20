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

test('the commit gate refuses a spec that would make vl-convert fetch: data.url, href, image marks (anywhere)', () => {
  const p = `${D}/panels/p_x.vl.json`;
  const bad = [
    { ...vl, data: { url: 'https://example.invalid/x.csv' } },
    { ...vl, transform: [{ lookup: 'k', from: { data: { url: 'https://example.invalid/y.json' }, key: 'k' } }] },
    { ...vl, encoding: { href: { field: 'link' } } },
    { ...vl, mark: 'image' },
    { ...vl, mark: { type: 'image' } },
  ];
  for (const spec of bad) assert.match(validateDashboardFile({ path: p, content: JSON.stringify(spec) }) ?? '', /refused/, JSON.stringify(spec));
});

test('NEGATIVE TWIN: the same specs without the fetching part pass the gate', () => {
  const p = `${D}/panels/p_x.vl.json`;
  const ok = [
    vl,
    { ...vl, data: { name: 'q' } },
    { ...vl, encoding: { x: { field: 'link', type: 'nominal' } } },
    { ...vl, mark: { type: 'text' } },
  ];
  for (const spec of ok) assert.equal(validateDashboardFile({ path: p, content: JSON.stringify(spec) }), null, JSON.stringify(spec));
});
