/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Principal, getDataset, listDatasets } from '../data/store.ts';
import { type MetricRecord, metricRecord } from './governance.ts';
import { measureMember } from './model.ts';

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
};

function summariesFor(datasetId: string, user: Principal): MetricSummary[] {
  const d = getDataset(datasetId, user);
  return d.measures.map((m) => ({
    id: `${d.id}.${m.name}`,
    name: m.name,
    datasetId: d.id,
    datasetName: d.name,
    member: measureMember(d, m),
    tier: TIER_OF[d.tier],
    owner: d.owner,
    type: m.type,
  }));
}

export type MetricGroups = { mine: MetricSummary[]; domain: MetricSummary[]; marketplace: MetricSummary[] };

/** List every metric visible to the user, grouped like the other governed surfaces. */
export function listMetrics(user: Principal): MetricGroups {
  const groups = listDatasets(user);
  const ids = [...groups.mine, ...groups.domain, ...groups.marketplace].map((s) => s.id);
  const out: MetricGroups = { mine: [], domain: [], marketplace: [] };
  for (const id of ids) {
    for (const s of summariesFor(id, user)) {
      // The metric tier is personal|domain|marketplace; the registry group keys are
      // mine|domain|marketplace — map personal → mine (a personal metric is "mine").
      const key = s.tier === 'personal' ? 'mine' : s.tier;
      out[key].push(s);
    }
  }
  return out;
}

/** Resolve a metric id (`datasetId.measure`) into the full record for explore/govern. */
export function getMetric(metricId: string, user: Principal): MetricRecord {
  const lastDot = metricId.lastIndexOf('.');
  const datasetId = metricId.slice(0, lastDot);
  const measureName = metricId.slice(lastDot + 1);
  const d = getDataset(datasetId, user);
  const measure = d.measures.find((m) => m.name === measureName);
  if (!measure) {
    const e = new Error(`metric '${metricId}' not found`) as Error & { status: number };
    e.status = 404;
    throw e;
  }
  return metricRecord(d, measure, d.owner, TIER_OF[d.tier]);
}
