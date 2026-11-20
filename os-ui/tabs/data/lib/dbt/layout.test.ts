/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where the generated Dagster module lands, per repo layout (WP-49 on WP-55)
 * USER STORY: As the owner I want a migrated repo to get `data/dagster/definitions.py` next to
 *             `data/dbt/`, and a repo that is not migrated yet to keep exactly its old tree, so the
 *             Dagster image keeps wiring it from `os/schedules.yml` and no schedule is lost.
 * ARCHITECTURE: Pure — the real generator output through `relocateProject`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relocateProject } from '@tabs/data/lib/dbt/layout';
import { DATA_LAYOUT } from '@core/infra/data-layout';

const files = new Map([
  ['dbt_project.yml', 'name: x\n'],
  ['models/silver/silver_a.sql', 'select 1\n'],
  ['os/schedules.yml', 'version: 1\n'],
  [DATA_LAYOUT.dagsterDefinitionsPath, 'defs = None\n'],
  [DATA_LAYOUT.generatedHashesPath, 'version: 1\n'],
]);

test('v2: the dbt project moves under data/dbt; the Dagster module and its hash stay at their own paths', () => {
  const out = relocateProject(files, 2);
  assert.ok(out.has(`${DATA_LAYOUT.dbtProjectDir}/dbt_project.yml`));
  assert.ok(out.has(DATA_LAYOUT.dagsterDefinitionsPath), 'not data/dbt/data/dagster/…');
  assert.ok(out.has(DATA_LAYOUT.generatedHashesPath));
  assert.ok(![...out.keys()].some((k) => k.startsWith(`${DATA_LAYOUT.dbtProjectDir}/data/`)));
});

test('v1 (not migrated): no Dagster module and no hash record — the image keeps the os/schedules.yml path', () => {
  const out = relocateProject(files, 1);
  assert.deepEqual([...out.keys()].sort(), ['dbt_project.yml', 'models/silver/silver_a.sql', 'os/schedules.yml']);
});
