/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Data & Metrics links — a business process documents which governed datasets and
 * KPIs it runs on. Stored as plain id arrays on the workflow record (nil-safe for
 * old records: absent ⇒ empty). Validation is two pure steps so the API route stays
 * thin and both are unit-testable:
 *   1. normalizeWorkflowLinks — shape-check the untrusted body (arrays of strings,
 *      deduped, capped) or reject with null.
 *   2. filterVisibleLinks — re-resolve every id through the caller-scoped visibility
 *      guard (the route wires the data/metrics stores' canView); non-visible ids are
 *      SILENTLY dropped, never echoed back — no existence leak.
 */

export type WorkflowLinks = { datasets: string[]; metrics: string[] };

export const EMPTY_LINKS: WorkflowLinks = { datasets: [], metrics: [] };

/** Sanity cap — a process links a handful of datasets/KPIs, not a catalog. */
const MAX_LINKS = 50;

function cleanIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') return null;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, MAX_LINKS);
}

/** Shape-validate an untrusted `links` body. Returns null when malformed. */
export function normalizeWorkflowLinks(raw: unknown): WorkflowLinks | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const datasets = cleanIds(r.datasets ?? []);
  const metrics = cleanIds(r.metrics ?? []);
  if (!datasets || !metrics) return null;
  return { datasets, metrics };
}

/**
 * Keep only the ids the caller can VIEW (per the wired guard). Dropping is silent
 * by design — a 403 per id would leak which hidden artifacts exist.
 */
export function filterVisibleLinks(
  links: WorkflowLinks,
  isVisible: (kind: 'dataset' | 'metric', id: string) => boolean,
): WorkflowLinks {
  return {
    datasets: links.datasets.filter((id) => isVisible('dataset', id)),
    metrics: links.metrics.filter((id) => isVisible('metric', id)),
  };
}
