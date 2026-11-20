/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dry-run plan for the dataset version records the OS kept before WP-37
 * USER STORY: As the operator I want to see, before anything changes, what happens to every
 *             existing `os-versions-dataset` record and which datasets' Iceberg history is theirs
 *             alone, so that retiring the OS version log loses nothing and touches no shared table.
 * ARCHITECTURE:
 *   - Pure. Input: the datasets (any export `datasetsFromJson` reads, archived ones included) and
 *     the records of the retired `os-versions-dataset` index (a read-only search export).
 *   - Each record held a superseded `dataset.yaml` (a DEFINITION, not data). The definition history
 *     is the domain repository's git log, so a record is `superseded-by-git`; a record of a dataset
 *     that no longer exists is `orphan` (kept as evidence in the export, never re-created).
 *   - Each dataset gets the table its versions now come from, or the reason they do not
 *     (`shared_table` with its siblings, `legacy_lane`, `not_built`) — the same rule the live code
 *     uses (`resolveVersionTable`), applied as the owner.
 *   - There is no apply step. Nothing here writes, drops an index, rolls back or tags a table.
 */
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { resolveVersionTable, VersionTableError } from '@tabs/data/lib/dataset-versions';

export type VersionRecord = { kind?: string; artifactId: string; version: number; at: string; author: string; summary: string; state?: { yaml?: unknown } };

export type RecordPlan = { artifactId: string; version: number; at: string; action: 'superseded-by-git' | 'orphan'; reason: string };
export type DatasetPlan = {
  datasetId: string; name: string; owner: string; archived: boolean; records: number;
  versionsFrom: string | null; status: 'own_table' | 'legacy_lane_read_only' | 'shared_table' | 'not_built' | 'not_iceberg';
  siblings?: string[]; reason?: string;
};

/** Parse a search export (`hits.hits[]._source`) or a plain array of records. */
export function recordsFromJson(text: string): VersionRecord[] {
  const raw = JSON.parse(text) as unknown;
  const hits = (raw as { hits?: { hits?: { _source?: unknown }[] } })?.hits?.hits;
  const items = Array.isArray(raw) ? raw : Array.isArray(hits) ? hits.map((h) => h._source) : [];
  return (items as VersionRecord[]).filter((r) => r && typeof r.artifactId === 'string' && typeof r.version === 'number');
}

export function planVersionMigration(datasets: readonly (Dataset & { archived?: boolean })[], records: readonly VersionRecord[]) {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const recordPlans: RecordPlan[] = records.map((r) => byId.has(r.artifactId)
    ? { artifactId: r.artifactId, version: r.version, at: r.at, action: 'superseded-by-git', reason: 'a dataset.yaml definition; its history is the domain repository git log (get_history / diff_versions)' }
    : { artifactId: r.artifactId, version: r.version, at: r.at, action: 'orphan', reason: 'the dataset no longer exists; the record stays only in this export' });
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.artifactId, (counts.get(r.artifactId) ?? 0) + 1);

  const datasetPlans: DatasetPlan[] = datasets.map((d) => {
    const base = { datasetId: d.id, name: d.name, owner: d.owner, archived: !!d.archived, records: counts.get(d.id) ?? 0 };
    try {
      const t = resolveVersionTable(d, { id: d.owner, domains: [d.domain] }, datasets, { intent: 'read' });
      return { ...base, versionsFrom: t.fqn, status: t.legacyLane ? 'legacy_lane_read_only' : 'own_table' };
    } catch (e) {
      if (!(e instanceof VersionTableError)) throw e;
      const siblings = (e.detail.siblings as { id: string }[] | undefined)?.map((s) => s.id);
      return {
        ...base, versionsFrom: null, status: e.code === 'shared_table' ? 'shared_table' : e.code === 'not_iceberg' ? 'not_iceberg' : 'not_built',
        ...(siblings ? { siblings } : {}), reason: e.message,
      };
    }
  });
  return {
    records: recordPlans,
    datasets: datasetPlans,
    summary: {
      records: records.length,
      supersededByGit: recordPlans.filter((r) => r.action === 'superseded-by-git').length,
      orphans: recordPlans.filter((r) => r.action === 'orphan').length,
      ownTable: datasetPlans.filter((d) => d.status === 'own_table').length,
      legacyLaneReadOnly: datasetPlans.filter((d) => d.status === 'legacy_lane_read_only').length,
      sharedTable: datasetPlans.filter((d) => d.status === 'shared_table').length,
    },
  };
}
