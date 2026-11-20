/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where the Dagster definitions and the dbt project live in a domain repository.
 * USER STORY: As an engineer who clones a domain repo I want the Dagster code at `data/dagster/`
 *             and the dbt project at `data/dbt/` (component design 12, the git layout), so
 *             `cd data/dagster && dagster dev -m definitions` runs the data products with no OS.
 * ARCHITECTURE:
 *   - The paths WP-49's generator and readers use, taken from `core/infra/repo-layout.ts` (WP-55),
 *     the one source of every repo path. No path is spelled here.
 *   - The Dagster image mirrors them in `images/extensions/dagster/os_projects.py`
 *     (`DAGSTER_DEFINITIONS_PATH`, `DBT_PROJECT_DIR` from `OS_DBT_PROJECT_DIR`, `GENERATED_PATH`);
 *     `data-layout.test.ts` asserts the two agree.
 */
import { DAGSTER_DIR, DAGSTER_DEFINITIONS_PATH, configuredDbtProjectDir, osPath } from '@core/infra/repo-layout';

export const DATA_LAYOUT = {
  /** The dbt project's directory, relative to the repo root (design 12; `OS_DBT_PROJECT_DIR`). */
  dbtProjectDir: configuredDbtProjectDir(),
  /** The Dagster code location's directory, relative to the repo root (design 12). */
  dagsterDir: DAGSTER_DIR,
  /** The generated Dagster module (a normal code location: `dagster dev -m definitions`). */
  dagsterDefinitionsPath: DAGSTER_DEFINITIONS_PATH,
  /** OS layer: sha256 of each generated native file the platform executes (artifact contract C5). */
  generatedHashesPath: osPath('generated.yml'),
} as const;
