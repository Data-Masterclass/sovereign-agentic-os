/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `renderSemantic(plan)` — the semantic half of the generated dbt project
 * USER STORY: As a data engineer cloning my domain's repo I want to find the metrics in
 *             `models/semantic/<model>.yml` with the time spine beside them, in the same lane as
 *             the models they sit on — not in a private OS artefact nobody else can read
 *             (checklist M1, M9, M12).
 * ARCHITECTURE:
 *   - Pure renderer over the planner's output, called by `generate.ts`. One file per dataset that
 *     has at least one metric AND a dbt model to `ref()` — the `tested` (furthest) model, resolved
 *     from the PLAN. The predecessor guessed `ref('mart_<slug>')`, a model that does not exist in
 *     the generated project, so `dbt parse` would have failed on the whole domain the moment the
 *     artefact reached it.
 *   - LANES (M-R6.3): a personal dataset's semantic file lives under
 *     `models/personal/<uid>/semantic/`, a promoted one under `models/semantic/`. Promotion moves
 *     the file exactly as it moves the model, in the one regeneration commit.
 *   - NAME SPACE: measure and metric names are project-global in dbt, so ONE allocator pair is
 *     shared across every dataset of the domain; datasets are visited in sorted model order so the
 *     allocation is deterministic and the files are byte-stable.
 *   - NEVER EMIT INVALID YAML: each document is validated against the pinned spec and a document
 *     with violations is DROPPED with its violations recorded as refusals, because one bad key
 *     fails `dbt parse` for the entire domain — every other dataset included. Nothing throws: an
 *     odd record must never block a domain's commits (the `models.ts` rule).
 *   - The spine is emitted iff some emitted semantic model declares a time dimension.
 */
import type { ModelPlan, ModelPlanSet } from '@tabs/data/lib/dbt/models';
import { emitSemanticYaml, type SemanticDoc } from '@tabs/data/lib/dbt/semantic/model';
import { semanticDocFor, semanticNames, type MetricRefusal } from '@tabs/data/lib/dbt/semantic/from-measures';
import { validateSemanticDoc } from '@tabs/data/lib/dbt/semantic/validate';
import { renderTimeSpine } from '@tabs/data/lib/dbt/semantic/time-spine';

/** One emitted metric, for the README and for anything that needs the OS ↔ dbt mapping. */
export type EmittedMetric = {
  /** `<datasetId>.<measure>` — the OS metric id. */
  osMetric: string;
  /** The dbt metric name in this project. */
  name: string;
  type: string;
  /** The file it lives in. */
  path: string;
};

export type SemanticRender = {
  files: Map<string, string>;
  metrics: EmittedMetric[];
  /** Everything NOT emitted, with the reason — surfaced in the generated README. */
  refusals: (MetricRefusal & { dataset: string })[];
  /** True when the spine was emitted. */
  timeSpine: boolean;
};

/** The semantic file path for a dataset, in the lane its models live in. */
export function semanticPathFor(model: ModelPlan, semanticModelName: string): string {
  return model.schema.startsWith('personal_')
    ? `models/personal/${model.schema.slice('personal_'.length)}/semantic/${semanticModelName}.yml`
    : `models/semantic/${semanticModelName}.yml`;
}

export function renderSemantic(plan: ModelPlanSet): SemanticRender {
  const files = new Map<string, string>();
  const metrics: EmittedMetric[] = [];
  const refusals: (MetricRefusal & { dataset: string })[] = [];
  const alloc = semanticNames();
  let anyTimeDimension = false;

  // One semantic model per dataset, on its FURTHEST (tested) model — the gold mart the OS serves
  // metrics from. Sorted by model path by the planner, so the allocation order is deterministic.
  for (const m of plan.models) {
    if (!m.tested) continue;
    const d = m.dataset;
    if (!d.measures.length) continue;
    const { doc, refusals: refused } = semanticDocFor({ dataset: d, model: m.name }, alloc);
    for (const r of refused) refusals.push({ dataset: d.id, ...r });
    if (!doc.metrics.length) continue;

    const violations = validateSemanticDoc(doc);
    if (violations.length) {
      // A generator bug, not a user error — but emitting it would take the whole domain's
      // `dbt parse` down, so the document is dropped and the reason is recorded.
      for (const v of violations) refusals.push({ dataset: d.id, measure: '(document)', reason: `not spec-valid at the pinned dbt spec: ${v}` });
      continue;
    }
    const path = semanticPathFor(m, doc.semantic_models[0].name);
    files.set(path, emitSemanticYaml(doc));
    if (hasTimeDimension(doc)) anyTimeDimension = true;
    for (const metric of doc.metrics) {
      metrics.push({
        osMetric: metric.config?.meta?.os_metric ?? `${d.id}.${metric.name}`,
        name: metric.name,
        type: metric.type,
        path,
      });
    }
  }

  if (anyTimeDimension) for (const [p, c] of renderTimeSpine()) files.set(p, c);
  metrics.sort((a, b) => a.name.localeCompare(b.name));
  refusals.sort((a, b) => (a.dataset + a.measure).localeCompare(b.dataset + b.measure));
  return { files, metrics, refusals, timeSpine: anyTimeDimension };
}

function hasTimeDimension(doc: SemanticDoc): boolean {
  return doc.semantic_models.some((sm) => sm.dimensions.some((d) => d.type === 'time'));
}
