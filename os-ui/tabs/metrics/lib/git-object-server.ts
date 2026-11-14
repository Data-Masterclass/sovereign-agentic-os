/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    The governed half of `registerGitObject('metric', …)` — the facts, read as the caller
 * USER STORY: As any user I want a KPI's head commit, history and diff to work like a dataset's or
 *             a dashboard's, so "every number the OS serves has a version" is true for metrics too
 *             (checklist G3/G7). A metric I may not see must answer exactly what one that does not
 *             exist answers.
 * ARCHITECTURE:
 *   - TWO HALVES, DELIBERATELY SPLIT. `lib/git-object.ts` is PURE (the paths and the trailer, no
 *     store, importable from a client); this module is the SERVER half that obtains the three
 *     facts that path needs — `{domain, semanticModel, ownerUid}` — through the tab's OWN governed
 *     read, `getMetric(id, caller)`. There is no ungoverned read of a metric here, and no second
 *     visibility rule: `getMetric` resolves the owning dataset through `getDataset`, so a metric
 *     on a dataset the caller cannot see throws and becomes `null` → G's one byte-identical
 *     `not_found` (G5). The pattern is `lib/ref-resolver.ts`'s: one governed read, `null` on
 *     refusal, nothing invented.
 *   - The facts come off the record the governed read already returned — `record.dataset` — so
 *     there is no second round trip and no chance of reading a different dataset than the one the
 *     gate approved. `semanticModelName` / `laneUid` (lib/model.ts) are the SAME functions the
 *     emitter builds the file name and the lane from.
 *   - A metric is a MEASURE on a dataset, so its "domain" is the dataset's domain: the repo that
 *     holds the semantic YAML. Both lanes are always returned by `metricGitLocation`, because a
 *     promotion moves the file.
 *   - Server-only: it reaches the store. The registration line is in `instrumentation.ts`.
 */
import 'server-only';
import type { GitObjectLocation } from '@core/infra/git-objects';
import { getMetric } from '@tabs/metrics/lib/store';
import { semanticModelName, laneUid } from '@tabs/metrics/lib/model';
import { metricGitLocation, type MetricGitFacts } from '@tabs/metrics/lib/git-object';

/** The caller, narrowed to what the governed read needs (G passes its `CurrentUser`). */
export type MetricGitObjectUser = { id: string; domains: string[]; role: string };

/**
 * The three facts a metric's repo path is built from, read AS THE CALLER. `null` means "no such
 * metric OR you may not see it" — one answer, on purpose.
 *
 * `read` is injected so the gating is testable without a store; the registration passes
 * `getMetric`, which is the governed door.
 */
export function metricGitFacts(
  user: MetricGitObjectUser,
  id: string,
  read: (id: string, user: MetricGitObjectUser) => { dataset: { domain: string; owner: string; name: string; slug?: string }; measure: { name: string } },
): MetricGitFacts | null {
  let record;
  try {
    record = read(id, user);
  } catch {
    return null;
  }
  const dataset = record?.dataset;
  if (!dataset || !dataset.domain) return null;
  return {
    domain: dataset.domain,
    semanticModel: semanticModelName(dataset as Parameters<typeof semanticModelName>[0]),
    ownerUid: laneUid(dataset.owner),
    name: `${dataset.name} · ${record.measure.name}`,
  };
}

/** The resolver `instrumentation.ts` registers for the `metric` kind. */
export function metricGitObjectResolver(user: MetricGitObjectUser, id: string): GitObjectLocation | null {
  const facts = metricGitFacts(user, id, (metricId, principal) =>
    getMetric(metricId, { id: principal.id, domains: principal.domains, role: principal.role as Parameters<typeof getMetric>[1]['role'] }),
  );
  return facts ? metricGitLocation(id, facts) : null;
}
