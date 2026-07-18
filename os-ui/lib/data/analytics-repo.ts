/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Analytics monorepo writer (epic #146 Phase 2).
 *
 * A PURE module: given a ForgejoClient and a governed dataset list it computes
 * the desired file set for the `analytics` repo and writes ONLY diffs (sha-based
 * writes — no commit when content is unchanged). Reuses the existing emitters
 * byte-for-byte: `buildCubeModels` + `CUBE_ARTIFACT` / `EXPOSURE_ARTIFACT` from
 * the metrics module. No new naming logic — the #155 namespacing decision lives
 * entirely in those callers.
 *
 * Fire-and-forget entry point: `syncAnalyticsRepo`. It never throws into the
 * caller — errors are swallowed and logged exactly like os-mirror.ts does.
 *
 * Hook points wired:
 *   - promote success (publish.ts `publishApprovedPromotion`)
 *
 * TODO (Phase 2 follow-up):
 *   - metric define: hook after a metric is added to a dataset
 *   - dataset archive: delete the cube artifact from the repo on archive
 */

import type { ForgejoClient } from '../infra/forgejo.ts';
import type { Dataset } from './dataset-schema.ts';
import { buildCubeModels, cubeDeliverable } from './cube-models.ts';
import { CUBE_ARTIFACT, EXPOSURE_ARTIFACT, scaffoldExposureYaml } from './metrics.ts';

const ANALYTICS_REPO = 'analytics';

/** Write `content` to `path` in the analytics repo; skip when unchanged (sha-based diff). */
async function diffWrite(
  forgejo: ForgejoClient,
  path: string,
  content: string,
  principal: string,
): Promise<void> {
  const existing = await forgejo.readFile(ANALYTICS_REPO, path);
  if (existing && existing.content === content) return; // no-op: byte-identical
  await forgejo.writeFile(
    ANALYTICS_REPO,
    path,
    content,
    existing?.sha,
    `analytics-sync: ${path} [by ${principal}]`,
  );
}

/**
 * Compute + write the governed Cube models and the dbt exposures file into the
 * analytics repo. Idempotent and diff-only (no write when content is unchanged).
 *
 * Does NOT create the repo — Phase 1 chart seed handles that. If the repo is
 * absent, `readFile` returns null → every file is treated as new and written.
 */
export async function writeAnalyticsFiles(
  forgejo: ForgejoClient,
  datasets: Dataset[],
  principal: string,
): Promise<void> {
  const payload = buildCubeModels(datasets);

  // 1. One cube model file per governed dataset.
  for (const entry of payload.models) {
    // CUBE_ARTIFACT uses the same identity as buildCubeModels — byte-for-byte
    // reuse, never re-implementing naming. The repo path is:
    //   dbt/models/governed/<slug>.cube.yml  for namespaced datasets
    //   dbt/models/governed/<slug>.cube.yml  for legacy (same slug, no prefix)
    // But the existing CUBE_ARTIFACT already returns `metrics/<slug>.cube.yml`;
    // in the analytics repo we mirror the same path so the Cube sync sidecar
    // can read either location interchangeably.
    const repoPath = `cube/models/metrics/${entry.file.replace(/^metrics\//, '')}`;
    await diffWrite(forgejo, repoPath, entry.model, principal);
  }

  // 2. A single dbt exposures file (all governed datasets, one exposure each).
  const deliverable = datasets.filter(cubeDeliverable);
  if (deliverable.length > 0) {
    // One `exposures:` block with all datasets concatenated (standard dbt pattern).
    const exposureYaml =
      'version: 2\n\n' +
      deliverable
        .map((d) => scaffoldExposureYaml(d).replace(/^exposures:\n/, ''))
        .join('');
    await diffWrite(forgejo, `dbt/${EXPOSURE_ARTIFACT}`, `exposures:\n${exposureYaml}`, principal);
  }
}

/**
 * Fire-and-forget wrapper. Never throws — logs errors and returns without
 * blocking the caller. Matches the pattern in lib/infra/os-mirror.ts.
 */
export function syncAnalyticsRepo(
  forgejo: ForgejoClient,
  datasets: Dataset[],
  principal: string,
): void {
  void writeAnalyticsFiles(forgejo, datasets, principal).catch((err: unknown) => {
    console.error('[analytics-repo] sync error:', err instanceof Error ? err.message : String(err));
  });
}
