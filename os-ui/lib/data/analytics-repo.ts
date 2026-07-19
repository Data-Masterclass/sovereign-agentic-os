/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Analytics monorepo writer (epic #146 Phase 2 + Phase 6).
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
 * Phase 6 (#146): git-backed dbt models. For each governed dataset with
 * `gitBacked: true`, two additional files are emitted into the analytics repo:
 *   - `dbt/models/governed/<domainslug>/<layer>_<slug>.sql`  — the publishPlan
 *     SELECT body, wrapped in a dbt config header (lineage/reproducibility grade).
 *   - `dbt/models/governed/<domainslug>/schema.yml`          — column docs.
 * The RUNTIME governed CTAS in publish-server.ts is NOT changed — these files
 * are observability artefacts only. Legacy datasets (gitBacked absent/false) emit
 * nothing new (byte-stable, zero migration).
 *
 * TODO (Phase 2 follow-up):
 *   - metric define: hook after a metric is added to a dataset
 *   - dataset archive: delete the cube artifact from the repo on archive
 */

import type { ForgejoClient } from '../infra/forgejo.ts';
import type { Dataset } from './dataset-schema.ts';
import { buildCubeModels, cubeDeliverable } from './cube-models.ts';
import { CUBE_ARTIFACT, EXPOSURE_ARTIFACT, scaffoldExposureYaml, slug } from './metrics.ts';
import { domainSchema } from './store-fqn.ts';

const ANALYTICS_REPO = 'analytics';

// ─── Phase 6: dbt model emitters ─────────────────────────────────────────────

/**
 * The promoted layer (gold preferred, then silver) for a dataset. Mirrors the
 * layer-selection logic in `publishPlan` (transform.ts) without importing the
 * server-only module or executing anything.
 */
function promotedLayer(d: Dataset): 'gold' | 'silver' | null {
  if (d.versions.gold.built) return 'gold';
  if (d.versions.silver.built) return 'silver';
  return null;
}

/**
 * The repo-relative path for a dataset's git-backed dbt model SQL file.
 * `dbt/models/governed/<domainslug>/<layer>_<slug>.sql`
 */
export function dbtModelPath(d: Dataset): string | null {
  const layer = promotedLayer(d);
  if (!layer) return null;
  return `dbt/models/governed/${domainSchema(d.domain)}/${layer}_${slug(d.name)}.sql`;
}

/**
 * The repo-relative path for a domain's governed schema.yml (column docs).
 * `dbt/models/governed/<domainslug>/schema.yml`
 */
export function dbtSchemaPath(d: Dataset): string {
  return `dbt/models/governed/${domainSchema(d.domain)}/schema.yml`;
}

/**
 * The dbt model SQL content: a `{{ config(...) }}` header + the publishPlan
 * SELECT body (byte-identical to what the runtime CTAS executes, minus the
 * `create or replace table <target> as` prefix — the SELECT is the dbt contract).
 *
 * This is PURELY a recording of what the governed promotion materializes — the
 * actual runtime path (publish-server.ts → publishPlan) is NOT changed.
 *
 * Returns null when neither gold nor silver is built (nothing to record).
 */
export function buildDbtModelSql(d: Dataset): string | null {
  const layer = promotedLayer(d);
  if (!layer) return null;
  const s = slug(d.name);
  const schema = domainSchema(d.domain);
  // The SELECT body mirrors publishPlan's CTAS source (personal lane of the owner).
  // We record only the SELECT — dbt materialises this; the RUNTIME CTAS in
  // publish-server.ts stays the actual execution path (unchanged).
  const selectBody = `select * from iceberg.personal_${slug(d.owner)}.${layer}_${s}`;
  return [
    `{{ config(materialized='table', schema='${schema}') }}`,
    '',
    selectBody,
    '',
  ].join('\n');
}

/**
 * The dbt schema.yml for one domain's governed datasets (column descriptions).
 * Appends (or creates) one `models:` entry per dataset; multiple datasets in the
 * same domain share ONE schema.yml, so this function merges the new entry into
 * whatever existing YAML is already in the repo (plain text append — dbt allows
 * multiple `models:` blocks per schema.yml, and the diff-write ensures idempotency).
 *
 * Returns a complete schema.yml string for the given datasets.
 */
export function buildDbtSchemaYaml(datasets: Dataset[]): string {
  const entries = datasets.map((d) => {
    const layer = promotedLayer(d);
    const modelName = layer ? `${layer}_${slug(d.name)}` : slug(d.name);
    const colLines = d.columns
      .filter((c) => c.description.trim().length > 0)
      .map((c) => [
        `      - name: ${c.name}`,
        `        description: "${c.description.replace(/"/g, '\\"')}"`,
      ].join('\n'))
      .join('\n');
    return [
      `  - name: ${modelName}`,
      `    description: "${d.description.replace(/"/g, '\\"')}"`,
      ...(colLines ? ['    columns:', colLines] : []),
    ].join('\n');
  });
  return ['version: 2', '', 'models:', ...entries, ''].join('\n');
}

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

  // 3. Phase 6 (#146): git-backed dbt models — one SQL file + per-domain schema.yml.
  //    Gated on `d.gitBacked === true`. Legacy datasets (marker absent) are NOT emitted
  //    (byte-stable — existing repos see no new files until a dataset is re-promoted).
  const gitBackedDeliverable = deliverable.filter((d) => d.gitBacked === true);
  for (const d of gitBackedDeliverable) {
    const sqlPath = dbtModelPath(d);
    const sqlContent = buildDbtModelSql(d);
    if (sqlPath && sqlContent) {
      await diffWrite(forgejo, sqlPath, sqlContent, principal);
    }
  }
  // Per-domain schema.yml: group git-backed datasets by domain, write one file per domain.
  const byDomain = new Map<string, Dataset[]>();
  for (const d of gitBackedDeliverable) {
    const key = domainSchema(d.domain);
    const list = byDomain.get(key) ?? [];
    list.push(d);
    byDomain.set(key, list);
  }
  for (const [, domainDatasets] of byDomain) {
    const schemaPath = dbtSchemaPath(domainDatasets[0]!);
    const schemaContent = buildDbtSchemaYaml(domainDatasets);
    await diffWrite(forgejo, schemaPath, schemaContent, principal);
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

// ─── Boot-time reconcile (once per process) ───────────────────────────────────

/**
 * Module-level guard: the reconcile runs AT MOST ONCE per os-ui process.
 * The guard is NOT reset on hot-reload in dev (module identity is stable
 * across HMR in the Node.js runtime). Call `_resetReconcileGuard()` in tests.
 */
let _reconciled = false;

/**
 * One-shot boot reconcile. Call this at process start (via `instrumentation.ts`
 * `register()`) to backfill any governed datasets that are missing from the
 * analytics git repo. No-op when:
 *   - already called this process (`_reconciled` guard)
 *   - Forgejo is down (errors swallowed, mirrors syncAnalyticsRepo discipline)
 *   - git is current (writeAnalyticsFiles is diff-only, no write when unchanged)
 *
 * The config-gate (FORGEJO_URL set?) lives in the instrumentation.ts caller so
 * this function stays pure and injectable in tests. An operator who wants an
 * IMMEDIATE reconcile without waiting for a restart can POST
 * /api/admin/analytics/backfill — that endpoint awaits the result and reports it.
 */
export function reconcileAnalyticsRepo(
  forgejo: ForgejoClient,
  datasets: Dataset[],
): void {
  if (_reconciled) return;
  _reconciled = true;
  syncAnalyticsRepo(forgejo, datasets, 'system-boot');
}

/** Reset the once-per-process guard. Test-only — never call in production. */
export function _resetReconcileGuard(): void {
  _reconciled = false;
}
