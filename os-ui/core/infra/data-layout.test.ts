/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Dagster image and os-ui agree on where a domain repo's data products live.
 * USER STORY: As a maintainer I want a layout change in repo-layout.ts to fail here unless the
 *             Dagster image's loader (os_projects.py) moves with it.
 * ARCHITECTURE: Pure; reads os_projects.py's constants as text (no Python needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_LAYOUT } from '@core/infra/data-layout';

const PY = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'images', 'extensions', 'dagster', 'os_projects.py'), 'utf8');

test('os_projects.py uses the same definitions, dbt and hash paths as repo-layout.ts', () => {
  assert.equal(DATA_LAYOUT.dagsterDefinitionsPath, 'data/dagster/definitions.py');
  assert.match(PY, new RegExp(`^DAGSTER_DEFINITIONS_PATH = "${DATA_LAYOUT.dagsterDefinitionsPath}"$`, 'm'));
  // The image reads the dbt dir from the repo's own layout marker (WP-55); its default is this one.
  assert.match(PY, new RegExp(`^DEFAULT_DBT_PROJECT_DIR = "${DATA_LAYOUT.dbtProjectDir}"$`, 'm'));
  assert.match(PY, new RegExp(`^GENERATED_PATH = "${DATA_LAYOUT.generatedHashesPath}"$`, 'm'));
});
