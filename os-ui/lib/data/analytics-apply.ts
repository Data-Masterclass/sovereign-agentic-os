/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Analytics monorepo APPLY — the governed enforcement point (epic #146 Phase 1,
 * plan §3 step 6). THE ONLY door from git into compute.
 *
 * This is the pure, network-free core. Given a git sha and the set of CHANGED
 * OS-managed files (already read out of Forgejo by the route), it:
 *
 *   (a) maps each path → the registry dataset it mirrors, by INVERTING the SAME
 *       emitters the mirror uses — `dbtModelPath` / `CUBE_ARTIFACT` (via
 *       `artifactBase`) / `EXPOSURE_ARTIFACT`. No new naming logic is introduced;
 *       a path that no governed dataset round-trips to is either the whole-repo
 *       exposures mirror or a non-OS-managed / unknown path.
 *
 *   (b) ROUND-TRIP VERIFIES: re-emits the OS-managed file from the CURRENT
 *       registry via the SAME emitters and REJECTS the pushed change if its bytes
 *       are not a shape the emitters could produce. This is the honest
 *       single-writer guard — the registry stays authoritative for compute, git
 *       is a proposal, and anything the emitters can't reproduce is refused with a
 *       clear reason (never a silent drop, never a fake success).
 *
 *   (c) computes the registry UPDATE the change implies (which dataset, which
 *       op). This module DECIDES; the route (holding a Principal + the store)
 *       EXECUTES the op under OPA/tier/promotion checks. Keeping the decision pure
 *       leaves the network (Forgejo diff read) and the governed writes (store) at
 *       the edges, so this file is unit-testable against plain fixtures.
 *
 * Reuses (imports, NEVER re-implements): `dbtModelPath`, `buildDbtModelSql`,
 * `buildDbtSchemaYaml` from analytics-repo; `buildCubeModels`, `CUBE_ARTIFACT`,
 * `EXPOSURE_ARTIFACT`, `artifactBase`, `slug`, `scaffoldExposureYaml`,
 * `cubeDeliverable` from the metrics/cube emitters; `domainSchema` from store-fqn.
 * These are the SAME functions the mirror (`writeAnalyticsFiles`) writes with, so
 * "round-trips" == "the mirror would have written exactly these bytes".
 */

import type { Dataset } from './dataset-schema.ts';
import { buildCubeModels, cubeDeliverable } from './cube-models.ts';
import { CUBE_ARTIFACT, EXPOSURE_ARTIFACT, scaffoldExposureYaml } from './metrics.ts';
import { dbtModelPath, dbtSchemaPath, buildDbtModelSql, buildDbtSchemaYaml } from './analytics-repo.ts';
import { domainSchema } from './store-fqn.ts';

/** One OS-managed file as it was pushed to the repo AT the applied sha. */
export type ChangedFile = { path: string; content: string };

/** The kind of OS-managed artifact a path maps to (drives the registry op). */
export type ArtifactKind = 'cube' | 'dbt-sql' | 'dbt-schema' | 'exposures';

/**
 * The decision for ONE changed file. `ok:true` ⇒ the file round-trips against the
 * current registry (the mirror would have produced these exact bytes) and — for a
 * dataset-scoped file — names the dataset + kind so the route can run the governed
 * registry op AS the mapped principal. `ok:false` ⇒ a clear, honest reason the
 * apply must reject (never dropped silently). `ignored:true` ⇒ a human-space path
 * outside the OS-managed set: left untouched, never rejected.
 */
export type FileDecision = {
  path: string;
  ok: boolean;
  ignored?: boolean;
  kind?: ArtifactKind;
  datasetId?: string;
  reason?: string;
};

/** The whole-apply result: one decision per changed file + a roll-up flag. */
export type ApplyPlan = {
  /** true ⇒ every non-ignored file round-tripped; the route may proceed. */
  ok: boolean;
  decisions: FileDecision[];
};

/** OS-managed path predicate (plan §2). Everything else is human-space. */
export function isOsManagedPath(path: string): boolean {
  return (
    path === `dbt/${EXPOSURE_ARTIFACT}` ||
    path.startsWith('dbt/models/governed/') ||
    path.startsWith('cube/models/metrics/')
  );
}

/** The repo path the mirror writes a dataset's cube model to (inverse target of `CUBE_ARTIFACT`). */
function cubeRepoPath(d: Dataset): string {
  // Mirror path scheme (writeAnalyticsFiles): cube/models/metrics/<base>.cube.yml,
  // where CUBE_ARTIFACT(d) === `metrics/<base>.cube.yml`. Reuse the emitter, strip its prefix.
  return `cube/models/metrics/${CUBE_ARTIFACT(d).replace(/^metrics\//, '')}`;
}

/**
 * Invert a changed path → the governed dataset it mirrors, by ASKING each emitter
 * what path it WOULD produce for that dataset and matching. No path parsing/regex
 * that could drift from the emitters — the emitters are the single source of the
 * scheme, so the inversion can never disagree with the forward mirror.
 *
 * Returns the matched dataset + the artifact kind, or null when no governed
 * dataset owns the path (unknown OS-managed path).
 */
export function pathToDataset(
  path: string,
  datasets: Dataset[],
): { dataset: Dataset; kind: 'cube' | 'dbt-sql' | 'dbt-schema' } | null {
  for (const d of datasets) {
    if (path === cubeRepoPath(d)) return { dataset: d, kind: 'cube' };
    if (path === dbtModelPath(d)) return { dataset: d, kind: 'dbt-sql' };
    if (path === dbtSchemaPath(d)) return { dataset: d, kind: 'dbt-schema' };
  }
  return null;
}

/**
 * Re-emit the OS-managed bytes for a (dataset, kind) from the CURRENT registry via
 * the SAME emitters the mirror uses. The apply accepts a pushed file iff its bytes
 * equal this — the single-writer round-trip guard. Returns null when the emitter
 * produces nothing (e.g. a cube for an un-deliverable dataset), which the caller
 * treats as "not a shape the emitters can produce" ⇒ reject.
 *
 * For `dbt-schema` the emitter is per-DOMAIN (one schema.yml per domain), so we
 * re-emit over ALL git-backed datasets sharing this domain — exactly as
 * `writeAnalyticsFiles` does — so a multi-dataset schema.yml round-trips.
 */
export function reemit(
  dataset: Dataset,
  kind: 'cube' | 'dbt-sql' | 'dbt-schema',
  datasets: Dataset[],
): string | null {
  if (kind === 'cube') {
    const payload = buildCubeModels([dataset]);
    return payload.models[0]?.model ?? null;
  }
  if (kind === 'dbt-sql') {
    return buildDbtModelSql(dataset);
  }
  // dbt-schema: per-domain merge over the git-backed deliverable datasets in the
  // same domain (mirror scheme: writeAnalyticsFiles groups by domainSchema).
  const schema = domainSchema(dataset.domain);
  const domainDatasets = datasets.filter(
    (d) => d.gitBacked === true && cubeDeliverable(d) && domainSchema(d.domain) === schema,
  );
  if (domainDatasets.length === 0) return null;
  return buildDbtSchemaYaml(domainDatasets);
}

/**
 * The exposures file is a WHOLE-REPO mirror (all deliverable datasets, one exposure
 * each), not a per-dataset artifact. Re-emit it exactly as `writeAnalyticsFiles`
 * does so a pushed `dbt/models/exposures.yml` round-trips. Returns null when there
 * are no deliverable datasets (the mirror would not have written the file at all).
 */
export function reemitExposures(datasets: Dataset[]): string | null {
  const deliverable = datasets.filter(cubeDeliverable);
  if (deliverable.length === 0) return null;
  const body = deliverable
    .map((d) => scaffoldExposureYaml(d).replace(/^exposures:\n/, ''))
    .join('');
  return `exposures:\nversion: 2\n\n${body}`;
}

/**
 * Decide ONE changed file. Pure. The order matters: human-space paths are ignored
 * FIRST (never rejected), then the whole-repo exposures mirror, then per-dataset
 * artifacts. A dataset-scoped file that maps to no governed dataset, or whose bytes
 * don't round-trip, is REJECTED with a clear reason (honest single-writer guard).
 */
export function decideFile(file: ChangedFile, datasets: Dataset[]): FileDecision {
  const { path, content } = file;

  // 1. Non-OS-managed (human-space) paths are never the apply's business.
  if (!isOsManagedPath(path)) {
    return { path, ok: true, ignored: true };
  }

  // 2. The whole-repo exposures mirror (not dataset-scoped).
  if (path === `dbt/${EXPOSURE_ARTIFACT}`) {
    const expected = reemitExposures(datasets);
    if (expected === null) {
      return { path, ok: false, kind: 'exposures',
        reason: 'exposures.yml pushed but the registry has no governed datasets to mirror it from' };
    }
    if (content !== expected) {
      return { path, ok: false, kind: 'exposures',
        reason: 'exposures.yml does not round-trip: the pushed bytes are not what the OS emitter produces from the registry' };
    }
    return { path, ok: true, kind: 'exposures' };
  }

  // 3. Per-dataset OS-managed artifact (cube model / dbt sql / dbt schema).
  const hit = pathToDataset(path, datasets);
  if (!hit) {
    return { path, ok: false,
      reason: `OS-managed path '${path}' maps to no governed dataset in the registry` };
  }
  const expected = reemit(hit.dataset, hit.kind, datasets);
  if (expected === null) {
    return { path, ok: false, kind: hit.kind, datasetId: hit.dataset.id,
      reason: `${hit.kind} for dataset '${hit.dataset.id}' cannot be produced by the OS emitters (not a round-trippable shape)` };
  }
  if (content !== expected) {
    return { path, ok: false, kind: hit.kind, datasetId: hit.dataset.id,
      reason: `${path} does not round-trip: the pushed bytes are not what the OS emitter produces for dataset '${hit.dataset.id}' (single-writer invariant — registry stays authoritative)` };
  }
  return { path, ok: true, kind: hit.kind, datasetId: hit.dataset.id };
}

/**
 * Plan the whole apply: decide every changed file. `ok` is true only when NO
 * non-ignored file was rejected — a single non-round-trippable OS-managed file
 * fails the apply (the route then posts an honest failure back to the PR).
 */
export function planApply(files: ChangedFile[], datasets: Dataset[]): ApplyPlan {
  const decisions = files.map((f) => decideFile(f, datasets));
  const ok = decisions.every((d) => d.ok);
  return { ok, decisions };
}
