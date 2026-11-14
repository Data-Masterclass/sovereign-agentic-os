/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    `models/**​/semantic/<model>.yml` pushed by an engineer → the metric registry
 * USER STORY: As an analytics engineer I want a pushed dbt `metrics:` file to be validated by the
 *             SAME validator the UI and the MCP use, so a push that would break the domain's
 *             `dbt parse` is refused on my terminal with the reason — and I want the OS to say
 *             plainly which parts of the file it re-derives and which it does not (D28, D29, E9).
 * ARCHITECTURE:
 *   - NIGHT-2 MERGE (E x M). Stream E owns the receive gate and the `registerRepoKind` seam;
 *     stream M owns what a pushed semantic file MEANS (`semantic/ingest.ts` `isSemanticPath` +
 *     `ingestFromRepo('metric', …)`). This file is the join and holds no parsing of its own.
 *   - ONE VALIDATOR, TWO DOORS (D28): validation runs M's `ingestFromRepo` over the single file,
 *     which calls `parseSemanticYaml` + `validateSemanticDoc` — the same pair the UI's and the
 *     MCP's write path call. A file with a problem is a 422 on the developer's terminal naming the
 *     file and the violations, and NOTHING of the push is applied.
 *   - WHAT IS AND IS NOT RE-DERIVED, said plainly rather than implied. A pushed file's DISPLAY
 *     metadata (the metric label) is applied through the governed `setMeasureLabel`, which re-gates
 *     edit scope. A measure's SEMANTICS — its aggregation, its expression, its filter — are NOT
 *     re-derived: M's `IngestedMetric` deliberately does not carry them (`agg` lives on the
 *     `semantic_models:` measure, not on the `metrics:` entry), so there is nothing here that could
 *     faithfully rebuild a `Measure`. Rather than guess one, the ingest REPORTS the file as read
 *     and says the definition must be changed in the OS. A silent accept would make the repository
 *     and the registry disagree with nothing to say so.
 *   - NEVER ATTACH A GUESS: a metric whose file carries no `config.meta.os_metric` /
 *     `os_dataset` is `unlinked` and is reported, never bound to a dataset by name — that would
 *     attach a number to the wrong data product.
 *   - NEVER RETIRE: a deleted semantic file is reported. Retiring a metric is a governed action.
 */
import { registerRepoKind, type ChangedFile, type IngestReport, type Pusher } from '@core/infra/git-receive';
import { runWithSurface } from '@core/infra/request-surface';
import { getDataset, setMeasureLabel, type Principal } from '@tabs/data/lib/store';
import { ingestFromRepo, isSemanticPath } from '@tabs/data/lib/dbt/semantic/ingest';

/** The `ingestFromRepo` key for this kind — the same string `GIT_OBJECT_KINDS` uses. */
export const METRIC_KIND = 'metric';

/** `models/semantic/<model>.yml` and `models/personal/<uid>/semantic/<model>.yml`. */
export function matchesSemantic(filePath: string): boolean {
  return isSemanticPath(filePath);
}

/**
 * The ONE validator, reached through M's own reader so the two cannot drift: a file that parses and
 * validates produces no problem for its path; anything else produces the sentence M wrote.
 */
export function validateSemanticFile(file: { path: string; content: string }): string | null {
  const result = ingestFromRepo(METRIC_KIND, new Map([[file.path, file.content]]));
  const problem = result.problems.find((p) => p.path === file.path);
  return problem ? problem.reason : null;
}

/** Apply a push's semantic files through the governed store, as the pusher. */
export async function ingestSemanticMetrics(input: {
  domain: string;
  files: ChangedFile[];
  pusher: Pusher;
  sha: string;
}): Promise<IngestReport> {
  const { files, pusher } = input;
  const report: IngestReport = { kind: METRIC_KIND, created: 0, updated: 0, skipped: 0, notes: [] };
  const principal: Principal = { id: pusher.id, domains: pusher.domains, role: pusher.role };

  const changed = new Map<string, string | null>();
  for (const f of files) {
    if (!matchesSemantic(f.path)) continue;
    changed.set(f.path, f.status === 'deleted' ? null : f.content);
  }
  if (changed.size === 0) return report;

  const result = ingestFromRepo(METRIC_KIND, changed);
  for (const path of result.deleted) {
    report.notes.push(`${path} was removed from the repo; retire the metric in the OS to remove it`);
  }
  for (const p of result.problems) {
    report.skipped += 1;
    report.notes.push(`${p.path}: ${p.reason}`);
  }

  for (const m of result.metrics) {
    if (m.unlinked || !m.datasetId) {
      report.skipped += 1;
      report.notes.push(
        `${m.path}: metric '${m.name}' carries no OS identity (config.meta.os_metric / os_dataset), so the OS ` +
          'cannot tell which data product it belongs to. It is left alone rather than attached by name — define ' +
          'it in the OS once and the emitter will write the meta back.',
      );
      continue;
    }
    try {
      runWithSurface('git:push', () => {
        const dataset = getDataset(m.datasetId!, principal);
        const measureName = m.member ? String(m.member).split('.').pop() ?? m.name : m.name;
        const measure = dataset.measures.find((x) => x.name === measureName);
        if (!measure) {
          throw new Error(
            `the OS has no measure '${measureName}' on dataset '${m.datasetId}'. A pushed file cannot CREATE a ` +
              'measure: its aggregation lives on the `semantic_models:` measure and the OS does not re-derive a ' +
              'definition from a push. Define the metric in the OS (or over the MCP) and push again.',
          );
        }
        const label = (m.label ?? '').trim();
        if (label && label !== (measure.label ?? '')) {
          setMeasureLabel(m.datasetId!, principal, measureName, label);
          report.updated += 1;
        } else {
          report.notes.push(
            `${m.path}: metric '${m.name}' was read and validated; its display label is unchanged. A measure's ` +
              'aggregation, expression and filter are NOT re-derived from a push — change those in the OS, which ' +
              'then re-emits this file.',
          );
        }
      });
    } catch (e) {
      report.skipped += 1;
      report.notes.push(`${m.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

/** Register this kind with the receive gate. Idempotent; called from the boot step. */
export function registerSemanticMetricIngest(): void {
  registerRepoKind({
    kind: METRIC_KIND,
    matches: matchesSemantic,
    validate: validateSemanticFile,
    ingest: ingestSemanticMetrics,
  });
}
