/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Project snapshot — the pure data view of a domain the dbt generator reads
 * USER STORY: As a maintainer I want generation to be a pure function of OS state, so the same
 *             state always yields the same project (checklist D3) and the generator is testable
 *             with literal fixtures, no store and no cluster.
 * ARCHITECTURE:
 *   - `ProjectSnapshot` = the domain's live (non-archived) datasets, each with its recorded
 *     native artifact bodies (the compiled Silver / Gold SQL `buildVersion` / `buildGoldJoin`
 *     stored), plus the resolved Trino catalog per sync connection.
 *   - `projectSnapshot(domain)` is the ONLY impure step: it reads the store and (optionally) the
 *     connection catalogs through an injected resolver. `generateProject` never touches either.
 *   - Datasets are sorted by id so every downstream file is byte-stable.
 */
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { datasetsForProject } from '@tabs/data/lib/store';

export type SnapshotDataset = {
  dataset: Dataset;
  /** Native artifact bodies keyed by artifact path (e.g. `gold/mart_orders.sql` → the CTAS). */
  artifacts: Record<string, string>;
  /**
   * Artifact paths whose body the OS COMPILED (provenance recorded by the store). Only these become
   * dbt models; a body without compiled provenance (authored by a user, or unknown) is rendered as a
   * SOURCE — dbt reads it, never rewrites it, and no user text reaches Jinja (review M2).
   */
  compiled?: string[];
};

export type ProjectSnapshot = {
  domain: string;
  /** Sorted by `dataset.id`. */
  datasets: SnapshotDataset[];
  /**
   * `connectionId` → the Trino catalog the connection mounts. `null` = resolved as a
   * NON-catalog (API-batch) connection; ABSENT = could not be resolved (the generator then
   * emits the source without a database and flags it `os_catalog: unresolved`).
   */
  catalogs: Record<string, string | null>;
};

export type SnapshotDeps = {
  /** Resolve a sync connection's Trino catalog for the dataset owner. `undefined` = unresolved. */
  connectionCatalog?: (connectionId: string, ownerId: string) => Promise<string | null | undefined>;
};

/**
 * Read the store (unscoped, server-side) into a pure snapshot. `captured` is the store read taken
 * SYNCHRONOUSLY in the writer's turn (the commit hook passes it) so two rapid writes cannot both
 * snapshot the later state and mis-attribute the first commit (review M3).
 */
export async function projectSnapshot(domain: string, deps: SnapshotDeps = {}, captured?: SnapshotDataset[]): Promise<ProjectSnapshot> {
  const datasets = captured ?? datasetsForProject(domain);
  const catalogs: Record<string, string | null> = {};
  if (deps.connectionCatalog) {
    const seen = new Map<string, string>(); // connectionId → ownerId (first owner wins)
    for (const { dataset } of datasets) {
      if (dataset.sync && !seen.has(dataset.sync.connectionId)) seen.set(dataset.sync.connectionId, dataset.owner);
    }
    for (const [connectionId, ownerId] of [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const c = await deps.connectionCatalog(connectionId, ownerId);
      if (c !== undefined) catalogs[connectionId] = c;
    }
  }
  return { domain, datasets, catalogs };
}
