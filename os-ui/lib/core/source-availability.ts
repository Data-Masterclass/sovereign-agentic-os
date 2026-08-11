/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * SOURCE-AVAILABILITY predicate — the tiny, pure, client-safe rule the graceful
 * lifecycle spine (0.6.98) shares so consumer tiles DEGRADE instead of throwing when
 * the artifact they were built on disappears.
 *
 * The live incident: a user DEMOTED (Shared → Personal) a dataset that a metric and a
 * dashboard panel depended on. Demotion narrows the dataset to owner-only AND moves its
 * physical lane, so dependents silently lost access and a naive deref (`dataset.name`,
 * `metricIdOf(member)!`) threw a client-side exception that white-screened the tab. The
 * owner's decision is warn-then-ALLOW on the lifecycle side, and DEGRADE gracefully on the
 * consumer side — an honest inline "source unavailable" note on THAT tile while the rest
 * of the tab renders normally.
 *
 * This module is the consumer-side predicate. It is DOM-free + import-free so it unit-tests
 * in isolation and both the Metrics and Dashboards components share one source of truth.
 * The <SourceUnavailable> React skin lives in components/core/SourceUnavailable.tsx.
 */

/** The calm, honest reason we show when a consumer's source artifact is gone. */
export const SOURCE_UNAVAILABLE_REASON =
  'Source dataset unavailable — it was demoted to Personal, archived, or deleted. ' +
  'Restore or re-promote it, or point this at a live dataset.';

/**
 * A DASHBOARD PANEL degrades when — the metric registry having FINISHED loading — NONE of
 * the panel's metric members resolves to a live metric id. `resolve` is the same
 * member → metric-id lookup the panel-header backlink already uses (`metricIdOf`), built
 * from the viewer's RLS-scoped registry: a member whose dataset was demoted/archived/deleted
 * is simply absent, so it resolves to `undefined`.
 *
 * A panel that declares NO members can't be judged "unavailable" (there is nothing to
 * resolve) — it renders as before. While the registry is still LOADING we must NOT degrade
 * (every member resolves to undefined transiently) — the caller passes `registryReady=false`
 * during load, and this returns false. Returns false the moment ANY member resolves.
 */
export function panelSourceUnavailable(
  members: readonly string[],
  resolve: (member: string) => string | undefined,
  registryReady: boolean,
): boolean {
  if (!registryReady) return false;
  if (members.length === 0) return false;
  return members.every((m) => resolve(m) === undefined);
}

/**
 * A METRIC tile degrades when its source dataset is no longer among the datasets the viewer
 * can see. `visibleDatasetIds` is the set of dataset ids currently resolvable to the viewer;
 * a metric whose `datasetId` fell out (demoted to another lane, archived, deleted) is
 * unavailable. An empty/unknown `datasetId` is treated as unavailable (nothing to deref).
 *
 * `visibleDatasetIds` empty is treated as "not yet known" → we do NOT degrade (avoid a
 * false negative before the dataset set has loaded).
 */
export function metricSourceUnavailable(
  datasetId: string | undefined,
  visibleDatasetIds: ReadonlySet<string>,
): boolean {
  if (visibleDatasetIds.size === 0) return false; // set not loaded yet — don't degrade
  if (!datasetId) return true;
  return !visibleDatasetIds.has(datasetId);
}
