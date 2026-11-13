/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The per-dataset PREVIEW of the dbt semantic declaration (`semantic/<model>.yml`)
 * USER STORY: As a creator looking at my dataset's files I want to see the same dbt
 *             `semantic_models:` + `metrics:` YAML that is committed into my domain's dbt project
 *             — one artefact, not a second, differently-shaped one.
 * ARCHITECTURE:
 *   - This file used to BE the emitter: 124 lines of `lines.push()` with no schema, no validation
 *     and no parser, emitting `ref('mart_<slug>')` (a model that does not exist in the generated
 *     project) and `expr: "{{ metric('x') }}"` for derived metrics (not a form dbt accepts). It is
 *     now a thin PREVIEW over the typed emitter in `dbt/semantic/` — one model, one emitter, one
 *     parser, one validator (checklist M1, M3).
 *   - The AUTHORITATIVE file is the one `generateProject` writes into the domain's dbt project at
 *     `models/semantic/<model>.yml` (or the owner's personal lane). This preview exists because the
 *     dataset-files surface lists it; it resolves the model ref from the dataset's furthest BUILT
 *     layer, which is what the planner names it.
 */
import type { Dataset, Layer } from '@tabs/data/lib/dataset-schema';
import { modelName } from '@tabs/data/lib/metrics';
import { physicalSlug } from '@tabs/data/lib/store-fqn';
import { emitSemanticYaml } from '@tabs/data/lib/dbt/semantic/model';
import { semanticDocFor } from '@tabs/data/lib/dbt/semantic/from-measures';

const LAYER_ORDER: Layer[] = ['bronze', 'silver', 'gold'];

/** The dbt model name the planner gives this dataset's furthest built layer. */
export function datasetModelName(d: Dataset): string {
  const furthest = [...LAYER_ORDER].reverse().find((l) => d.versions[l].built) ?? 'gold';
  return `${furthest}_${physicalSlug(d)}`;
}

/**
 * The dbt semantic declaration for a dataset — `semantic_models:` + `metrics:`, byte-identical to
 * what the generated project carries. Empty string when the dataset has no emittable metric.
 */
export function scaffoldSemanticYaml(d: Dataset): string {
  const { doc } = semanticDocFor({ dataset: d, model: datasetModelName(d) });
  // No metric ⇒ no file: a semantic model with no metric on it is noise in the repo, and the
  // generator skips it for the same reason (`dbt/semantic/render.ts`).
  return doc.metrics.length ? emitSemanticYaml(doc) : '';
}

/** One semantic declaration file per dataset — the SAME namespacing scheme as the cube artifact. */
export const SEMANTIC_ARTIFACT = (d: Dataset) => `semantic/${modelName(d)}.yml`;
