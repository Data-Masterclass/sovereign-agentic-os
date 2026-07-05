/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset } from './dataset-schema.ts';
import { CUBE_ARTIFACT, cubeName, cubeViewName, scaffoldCubeYaml } from './metrics.ts';
import { type CubeAccessPolicy, compileCube } from './policy/compiler.ts';

/**
 * The Cube model-delivery payload (data-tab-plan §B stage 5, §C T7). ONE source —
 * the governed dataset registry — is compiled to the exact files Cube loads: the
 * `cube_dbt` model (`scaffoldCubeYaml`) plus the compiled Cube access policy
 * (`policy/compiler.compileCube`, the SAME source that feeds Trino OPA, so the two
 * enforcement points can't drift). Served on a cluster-internal route
 * (`GET /api/cube/models`) that a model-sync sidecar polls; this module is pure +
 * tested so the endpoint, the sidecar and the panel preview all agree.
 */

export type CubeModelEntry = {
  /** The cube name (`slug(name)`) — matches the OPA/compiler key. */
  name: string;
  /** The curated view dashboards + the agent metrics tool resolve. */
  view: string;
  /** The file the sidecar writes into Cube's model dir (`metrics/<slug>.cube.yml`). */
  file: string;
  /** The measure members exposed on the view (falls back to `count`, as the YAML does). */
  measures: string[];
  /** The compiled Cube access policy for this cube (row/member governance source). */
  access: CubeAccessPolicy;
  /** The delivered model YAML (`cube` + `view`, plus embedded member_level excludes). */
  model: string;
};

export type CubeModelsPayload = { generatedAt: string; models: CubeModelEntry[] };

/**
 * A dataset is delivered to Cube when it is a shared asset / certified product AND
 * its Gold mart is built. The tier gate is the privacy boundary — a private
 * `dataset` never leaves the owner's lane, so it is never emitted (the caller,
 * `store.listGovernedDatasets`, already drops private tiers; this is the physical
 * guard: Cube binds to `iceberg.<domain>.gold_<slug>`, which must exist first).
 */
export function cubeDeliverable(d: Dataset): boolean {
  return d.tier !== 'dataset' && d.versions.gold.built;
}

/** The compiled Cube access policy → a `member_level.excludes` block. Restricted
 *  columns are EXCLUDED in Cube (the mask-vs-hide contract: masked in Trino, hidden
 *  in Cube). Domain/user row gating stays in the returned `access` (delivered for
 *  audit) + the Trino-OPA path; embedding a Cube row-level policy is deferred until
 *  it is validated on the live Cube version (data-tab-plan risk #2). */
function accessPolicyBlock(excludes: string[]): string {
  return [
    '    access_policy:',
    '      - role: "*"',
    '        member_level:',
    `          excludes: [${excludes.join(', ')}]`,
  ].join('\n');
}

/** The model YAML delivered to Cube: the `scaffoldCubeYaml` contract, plus the
 *  access policy's member_level excludes inserted as a sibling of measures/dimensions
 *  (only when there ARE restricted columns and embedding is on). */
export function cubeModelYaml(d: Dataset, access: CubeAccessPolicy, embed: boolean): string {
  const base = scaffoldCubeYaml(d);
  if (!embed || access.excludes.length === 0) return base;
  return base.replace('\n\nviews:', `\n${accessPolicyBlock(access.excludes)}\n\nviews:`);
}

/**
 * Build the Cube-models payload from the governed datasets. `embedAccessPolicy`
 * defaults on; the endpoint wires it from config so the risk-#2 fallback (serve
 * plain models if a Cube version rejects `access_policy`) is a single env flip.
 */
export function buildCubeModels(
  datasets: Dataset[],
  opts: { embedAccessPolicy?: boolean; now?: () => string } = {},
): CubeModelsPayload {
  const embed = opts.embedAccessPolicy ?? true;
  const deliverable = datasets.filter(cubeDeliverable);
  const policies = new Map(compileCube(deliverable).map((p) => [p.cube, p]));
  const models: CubeModelEntry[] = [];
  for (const d of deliverable) {
    const access = policies.get(cubeName(d));
    if (!access) continue; // compileCube emits one policy per governed dataset
    models.push({
      name: cubeName(d),
      view: cubeViewName(d),
      file: CUBE_ARTIFACT(d),
      measures: d.measures.length ? d.measures.map((m) => m.name) : ['count'],
      access,
      model: cubeModelYaml(d, access, embed),
    });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return { generatedAt: (opts.now ?? (() => new Date().toISOString()))(), models };
}
