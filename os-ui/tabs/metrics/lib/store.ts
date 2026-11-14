/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Principal, getDataset, listDatasets, peekDatasetMeasureNames, listAllDatasets, ensureHydrated as ensureDataHydrated } from '@tabs/data/lib/store';
import { type MetricRecord, metricRecord } from '@tabs/metrics/lib/governance';
import { measureMember, dbtMetricType, metricTimeGrain, type DbtMetricType } from '@tabs/metrics/lib/model';
import { isMetricArchived, metricFolder } from '@tabs/metrics/lib/lifecycle';

/**
 * Metrics derived from the Data tab's datasets (read-only over lib/data/store) — a metric
 * IS a measure on a governed dataset, so the metric registry is just every measure the
 * user can see, lifted into a {@link MetricRecord} (with its canonical member + tier).
 * No second store, no drift: defining a measure in Data/Metrics is the single write; this
 * is the read model the explorer + governance list from.
 */

const TIER_OF = { dataset: 'personal', asset: 'domain', product: 'marketplace' } as const;

export type MetricSummary = {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string;
  member: string;
  tier: 'personal' | 'domain' | 'marketplace';
  owner: string;
  type: string;
  /** The dbt semantic-layer metric type this metric is emitted as — so a client can pick a valid
   *  slice without a round trip (M-R9.5). */
  metricType: DbtMetricType;
  /** The FINEST time grain this metric can be bucketed at; absent ⇒ no time dimension at all. */
  grain?: 'day';
  /** Source domain — set on shared/marketplace metrics for provenance display. */
  domain?: string;
  /** The folder this metric lives in (normalised path; `'/'` = root). Rides the metric
   *  lifecycle overlay — a metric has no store row of its own (it is a measure). */
  folder: string;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
  /** COMPOSITE metric (a formula over other metrics) — the transparency badge. */
  composite?: boolean;
  /** Plain-language "what does this metric mean?" — shown as a muted line on the tile.
   *  Absent ⇒ no line (layout unchanged). */
  description?: string;
  /** FAIL-SOFT (#91): set when this one metric/model couldn't be loaded — the tile
   *  renders its reason inline while the rest of the registry stays live. */
  error?: string;
};

function summariesFor(datasetId: string, user: Principal): MetricSummary[] {
  const d = getDataset(datasetId, user);
  return d.measures.map((m) => {
    const id = `${d.id}.${m.name}`;
    return {
      id,
      // DISPLAY name — the measure's `label` when renamed, else the machine `name`. The
      // physical member (`m.name`) is frozen across a rename, so only this display shifts.
      name: m.label ?? m.name,
      datasetId: d.id,
      datasetName: d.name,
      member: measureMember(d, m),
      tier: TIER_OF[d.tier],
      owner: d.owner,
      type: m.type,
      metricType: dbtMetricType(m),
      ...(metricTimeGrain(d) ? { grain: 'day' as const } : {}),
      domain: d.domain || undefined,
      folder: metricFolder(id),
      archived: isMetricArchived(id),
      ...(m.formula ? { composite: true } : {}),
      ...(m.description ? { description: m.description } : {}),
    };
  });
}

/**
 * FAIL-SOFT (#91): resolve one dataset's metric summaries, NEVER letting a single bad
 * model take down the whole registry. If a dataset can't be read or a measure can't be
 * lifted (a broken/invalid model), we return a single placeholder summary carrying the
 * inline `error` instead of throwing — so the Metrics surface still renders every other
 * metric and shows this one's reason inline (never a whole-tab 500 on one bad cube).
 */
export function safeSummariesFor(datasetId: string, user: Principal): MetricSummary[] {
  try {
    return summariesFor(datasetId, user);
  } catch (e) {
    return [{
      id: datasetId,
      name: datasetId,
      datasetId,
      datasetName: datasetId,
      member: '—',
      tier: 'personal',
      owner: user.id,
      type: 'error',
      metricType: 'simple',
      folder: '/',
      error: e instanceof Error ? e.message : 'this metric could not be loaded',
    }];
  }
}

export type MetricGroups = { mine: MetricSummary[]; domain: MetricSummary[]; marketplace: MetricSummary[] };

/** List every metric visible to the user, grouped like the other governed surfaces.
 *  Archived metrics are soft-hidden by default (reversible). */
export function listMetrics(user: Principal, opts: { includeArchived?: boolean } = {}): MetricGroups {
  const groups = listDatasets(user);
  const ids = [...groups.mine, ...groups.domain, ...groups.marketplace].map((s) => s.id);
  const out: MetricGroups = { mine: [], domain: [], marketplace: [] };
  for (const id of ids) {
    for (const s of safeSummariesFor(id, user)) {
      if (s.archived && !opts.includeArchived) continue;
      // The metric tier is personal|domain|marketplace; the registry group keys are
      // mine|domain|marketplace — map personal → mine (a personal metric is "mine").
      const key = s.tier === 'personal' ? 'mine' : s.tier;
      out[key].push(s);
    }
  }
  return out;
}

/** The ONE "no such metric" error — byte-identical whether it does not exist or you cannot see it. */
function metricNotFound(metricId: string): Error & { status: number } {
  const e = new Error(`metric '${metricId}' not found`) as Error & { status: number };
  e.status = 404;
  return e;
}

/**
 * Resolve a metric id (`datasetId.measure`) into the full record for explore/govern.
 *
 * REVIEW M-6 — EXISTENCE DOES NOT LEAK. A metric on a dataset the caller cannot see used to
 * surface `getDataset`'s 403, so `forbidden` meant "this metric exists and belongs to someone
 * else" while `not_found` meant "no such id" — an id could be probed for existence one call at a
 * time. Both now answer the same 404 with the same message, which is the rule the metric MCP
 * surface already documented (`query_metric`: "a metric on a dataset you cannot see → not_found")
 * and the rule stream G's `notFoundMessage` implements for every other kind. The DATASET tools
 * keep their own 403 — that is their surface's decision (B4-11), and a dataset id is already
 * discoverable through `list_datasets`; a metric id is not.
 */
export function getMetric(metricId: string, user: Principal): MetricRecord {
  const lastDot = metricId.lastIndexOf('.');
  const datasetId = metricId.slice(0, lastDot);
  const measureName = metricId.slice(lastDot + 1);
  let d;
  try {
    d = getDataset(datasetId, user);
  } catch (e) {
    // A 403 ("you may not see this dataset") and a 404 ("no such dataset") collapse into one
    // answer. Anything else — a store that failed to hydrate, say — is a real fault and is
    // re-thrown: swallowing it would turn an outage into a confident "not found".
    const status = (e as { status?: number }).status;
    if (status === 403 || status === 404) throw metricNotFound(metricId);
    throw e;
  }
  const measure = d.measures.find((m) => m.name === measureName);
  if (!measure) throw metricNotFound(metricId);
  return metricRecord(d, measure, d.owner, TIER_OF[d.tier]);
}

/** UNSCOPED existence peek for the declarative AppSpec validator (0.6.116): does the metric
 *  `datasetId.measure` exist at all? A metric IS a measure on a dataset, so this is true iff
 *  the dataset exists and declares the measure. Non-throwing + no authz (mirrors
 *  `peekDatasetMeta`) — the granted-check is a separate concern the validator owns. Returns
 *  false for a malformed id (no dot) or an absent dataset. */
export function peekMetricExists(metricId: string): boolean {
  const lastDot = metricId.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === metricId.length - 1) return false;
  const datasetId = metricId.slice(0, lastDot);
  const measureName = metricId.slice(lastDot + 1);
  const measures = peekDatasetMeasureNames(datasetId);
  return measures !== null && measures.includes(measureName);
}

// ---------------------------------------------------------------- lifecycle ---
/**
 * ADDITIVE (night 2, stream V). A metric has no store row of its own — it IS a measure on a
 * governed dataset — so the lifecycle migration cannot enumerate metrics from a metrics table.
 * These two exports let `tabs/metrics/lib/lifecycle-adapter.ts` enumerate and hydrate without
 * importing the Data tab itself (a tab imports only `@core/*` and itself).
 */
export { ensureDataHydrated as ensureHydrated };
export type { Principal };

/** Every measure on every dataset, platform-wide — ids, members and the owning domain. */
export function listAllMetricsInternal(): { id: string; member: string; domain: string }[] {
  const out: { id: string; member: string; domain: string }[] = [];
  for (const d of listAllDatasets()) {
    for (const name of peekDatasetMeasureNames(d.id) ?? []) {
      const measure = (d.measures ?? []).find((m) => m.name === name);
      if (!measure) continue;
      out.push({ id: `${d.id}.${name}`, member: measureMember(d, measure), domain: d.domain });
    }
  }
  return out;
}
