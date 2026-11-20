/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Legacy dataset versions: the definition snapshots the OS kept before WP-37, read-only.
 * USER STORY: As a data owner I want the dataset.yaml history recorded before versions became
 *             Iceberg snapshots to stay readable, so no definition-level history is lost.
 * ARCHITECTURE:
 *   - One OpenSearch `_search` (POST, a read) on the retired `os-versions-dataset` index, filtered to
 *     the dataset, through the OpenSearch adapter. No other method is ever sent: the index is not
 *     created, re-mapped, written or deleted here, and nothing in the OS writes it any more.
 *   - Honest states: `available:false` with the reason when OpenSearch does not answer, an empty list
 *     when the index or the dataset's records do not exist.
 *   - View-scoped like the dataset itself (`getDataset` refuses what the caller cannot see).
 *   - New definition history is git (`get_history`); data history is Iceberg (`dataset-versions.ts`).
 */
import { opensearchTry } from '@core/adapters/opensearch/client';
import { getDataset, type Principal } from '@tabs/data/lib/store';

export const LEGACY_VERSION_INDEX = 'os-versions-dataset';

export type LegacyDatasetVersion = { version: number; at: string; author: string; summary: string; yaml: string | null };
export type LegacyVersions = { available: true; versions: LegacyDatasetVersion[] } | { available: false; reason: string; versions: [] };

/** The pre-WP-37 definition snapshots of a dataset, newest first. Read-only. */
export async function listLegacyDatasetVersions(id: string, user: Principal): Promise<LegacyVersions> {
  getDataset(id, user); // view gate first: an unseen dataset is refused before the index is read
  const res = await opensearchTry(`/${LEGACY_VERSION_INDEX}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: 1000, query: { term: { artifactId: id } }, sort: [{ version: 'desc' }] }),
  });
  if (!res) return { available: false, reason: 'OpenSearch did not answer; the legacy history could not be read', versions: [] };
  if (res.status === 404) return { available: true, versions: [] }; // the index never existed here
  if (!res.ok) return { available: false, reason: `OpenSearch answered ${res.status}`, versions: [] };
  let body: { hits?: { hits?: { _source?: Record<string, unknown> }[] } };
  try {
    body = (await res.json()) as typeof body;
  } catch (e) {
    return { available: false, reason: `OpenSearch answered unreadable JSON (${(e as Error).message})`, versions: [] };
  }
  const versions = (body.hits?.hits ?? [])
    .map((h) => h._source ?? {})
    .filter((s) => s.artifactId === id && typeof s.version === 'number')
    .map((s) => ({
      version: s.version as number,
      at: String(s.at ?? ''),
      author: String(s.author ?? ''),
      summary: String(s.summary ?? ''),
      yaml: typeof (s.state as { yaml?: unknown } | undefined)?.yaml === 'string' ? (s.state as { yaml: string }).yaml : null,
    }))
    .sort((a, b) => b.version - a.version);
  return { available: true, versions };
}
