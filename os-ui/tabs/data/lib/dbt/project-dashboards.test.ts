/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-52 — the dbt project reads the dashboards' saved queries when dashboards are native
 * USER STORY: As an engineer I want `dbt parse` to validate every dashboard's saved queries and
 *             exposure against the project's metrics, at the repo root (v1) and from `data/dbt` (v2).
 * ARCHITECTURE:
 *   - Pure: `renderDbtProject` + `dashboardsModelPath`. Absent ⇒ `model-paths` is unchanged, so
 *     every existing golden stays byte-identical while the flag is off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'js-yaml';
import { renderDbtProject } from '@tabs/data/lib/dbt/project';
import { dashboardsModelPath } from '@core/infra/repo-layout';

const plan = { models: [], sources: [], layerDirs: [], personalUids: [] } as unknown as Parameters<typeof renderDbtProject>[1];
const paths = (p?: string) => (load(renderDbtProject('sales', plan, undefined, p)) as { 'model-paths': string[] })['model-paths'];

test('flag off: model-paths is [models] exactly as before', () => {
  assert.deepEqual(paths(), ['models']);
});

test('native dashboards: v1 reads `dashboards`, v2 reads `../../dashboards` from data/dbt', () => {
  assert.equal(dashboardsModelPath(1), 'dashboards');
  assert.equal(dashboardsModelPath(2, 'data/dbt'), '../../dashboards');
  assert.deepEqual(paths(dashboardsModelPath(1)), ['models', 'dashboards']);
});
