/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `ingestFromRepo('metric', files)` — pushed semantic YAML → the metric records it means
 * USER STORY: As an engineer I clone my domain's repo, edit `models/semantic/<model>.yml` in VS Code,
 *             `git push`, and the OS's metric registry reflects what I pushed — the same change made
 *             over the MCP leaves the registry in the same state (D29, the "coin test").
 * ARCHITECTURE:
 *   - PURE and TOTAL: (the changed files) → `{ metrics, problems }`. No store, no fs, no git. Stream
 *     E owns the orchestration (`reconcileFromGit`, the receive gate, the registry write attributed
 *     to the pusher with `OS-Surface: git:push`); this stream owns what a pushed metric file MEANS,
 *     because the file is this stream's artefact and a second reader would drift from the emitter
 *     within a week.
 *   - The file is AUTHORITATIVE and the registry row is a cache of it (the global design rule), so
 *     the OS identity is read from `config.meta.os_metric` / `os_dataset` where the OS wrote it, and
 *     a hand-authored metric with no such meta is reported as `unlinked` rather than guessed onto a
 *     dataset. Guessing would attach a number to the wrong data product.
 *   - VALIDATION IS SHARED, NOT REIMPLEMENTED (D28): the same `parseSemanticYaml` +
 *     `validateSemanticDoc` the UI and the MCP write path use. A file that does not validate is a
 *     PROBLEM naming the file and the violations — the receive gate turns that into the message on
 *     the developer's terminal — and NOTHING from that file is ingested.
 *   - Never throws: one unreadable file must not fail a whole push's reconcile, and a push that is
 *     rejected must be rejected by the gate with a reason, not by an exception.
 */
import { parseSemanticYaml, type SemanticMetric } from '@tabs/data/lib/dbt/semantic/model';
import { validateSemanticDoc } from '@tabs/data/lib/dbt/semantic/validate';

/** A path under which this stream's artefact lives (promoted lane or a personal lane). */
export const SEMANTIC_PATH_RE = /^models\/(?:semantic|personal\/[^/]+\/semantic)\/[^/]+\.yml$/;

/** Is this changed path one of the metric artefact's? Stream E routes on this. */
export function isSemanticPath(path: string): boolean {
  return SEMANTIC_PATH_RE.test(path);
}

/** One metric as the registry should hold it after a push. */
export type IngestedMetric = {
  /** The OS metric id (`<datasetId>.<measure>`) when the file carries it, else null. */
  osMetric: string | null;
  /** The OS dataset id the metric belongs to, when the file carries it. */
  datasetId: string | null;
  /** The OS member id, when the file carries it — the frozen identity a dashboard addresses. */
  member: string | null;
  /** The dbt metric name in the project. */
  name: string;
  type: SemanticMetric['type'];
  /** The dbt semantic model it sits on. */
  semanticModel: string;
  /** The dbt model that semantic model `ref()`s. */
  model: string;
  /** The repo path it was read from. */
  path: string;
  label?: string;
  description?: string;
  /** The dbt filter expression, verbatim, when the metric carries one. */
  filter?: string;
  /** True when the file carries no OS identity, so the OS cannot attach it to a dataset. */
  unlinked: boolean;
};

export type IngestProblem = { path: string; reason: string };

export type IngestResult = { metrics: IngestedMetric[]; problems: IngestProblem[] };

/** `ref('gold_orders')` → `gold_orders`. */
function refTarget(ref: string): string {
  return /^ref\('([^']+)'\)$/.exec(ref)?.[1] ?? ref;
}

/**
 * Read every semantic file of a push into the metric records it means.
 *
 * `files` is path → content for the files the push CHANGED; a path that is not a semantic artefact
 * is ignored (stream E passes the whole changed set and routes by kind). A deleted file is passed
 * with `null`, and its path is returned in `deleted` so the caller can retire those rows.
 */
export function ingestFromRepo(kind: 'metric', files: Map<string, string | null>): IngestResult & { deleted: string[] } {
  void kind;
  const metrics: IngestedMetric[] = [];
  const problems: IngestProblem[] = [];
  const deleted: string[] = [];

  for (const path of [...files.keys()].sort()) {
    if (!isSemanticPath(path)) continue;
    const content = files.get(path);
    if (content === null || content === undefined) {
      deleted.push(path);
      continue;
    }
    let doc;
    try {
      doc = parseSemanticYaml(content);
    } catch (e) {
      problems.push({ path, reason: `not valid YAML: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const violations = validateSemanticDoc(doc);
    if (violations.length) {
      // The SAME validator the UI and the MCP write path call (D28). A push that would make the
      // domain's `dbt parse` fail is a rejection with a readable reason, never a silent ingest.
      problems.push({ path, reason: `not valid for the pinned dbt semantic spec: ${violations.join('; ')}` });
      continue;
    }
    const sm = doc.semantic_models[0];
    if (!sm) {
      problems.push({ path, reason: 'no semantic_models: block — a metric file must declare the model its measures sit on' });
      continue;
    }
    for (const m of doc.metrics) {
      const meta = m.config?.meta ?? {};
      const osMetric = meta.os_metric ?? null;
      metrics.push({
        osMetric,
        datasetId: meta.os_dataset ?? null,
        member: meta.os_member ?? null,
        name: m.name,
        type: m.type,
        semanticModel: sm.name,
        model: refTarget(sm.model),
        path,
        ...(m.label ? { label: m.label } : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(m.filter ? { filter: m.filter } : {}),
        unlinked: !osMetric || !meta.os_dataset,
      });
    }
  }
  metrics.sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
  problems.sort((a, b) => a.path.localeCompare(b.path));
  return { metrics, problems, deleted };
}
