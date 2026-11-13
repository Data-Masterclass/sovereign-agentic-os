/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `datasetLineage(dataset)` — dbt's lineage when the flag is on, the registry's when not
 * USER STORY: As a data engineer I want the lineage view to show what dbt will really run, and I want
 *             it to keep working — with the old graph — when the data-project flag is off or Dagster
 *             is unreachable (checklist D16).
 * ARCHITECTURE:
 *   - ONE impure step: `assetGraph()` (one GraphQL call, 4 s timeout, injectable). Everything else is
 *     `tabs/data/lib/dbt/lineage.ts` (pure) and `lineage.ts` (the registry path, unchanged).
 *   - Fallback is explicit and LABELLED, never silent: `source: 'registry'` on the payload says the
 *     graph came from the OS's own records, so a surface can say so instead of implying dbt agreed.
 *   - Fallback triggers: flag off · Dagster not configured · the call failed · the dataset has no
 *     model in the graph yet (a brand-new dataset whose first commit has not been parsed).
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { assetGraph, dagsterConfigured, type DagsterDeps } from '@core/infra/dagster';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { lineageFor, type LineageGraph } from '@tabs/data/lib/lineage';
import { graphLineage } from '@tabs/data/lib/dbt/lineage';
import { datasetAssetKeys } from '@tabs/data/lib/dbt/asset-keys';
import { projectSnapshot } from '@tabs/data/lib/dbt/snapshot';

export type LineageDeps = {
  dagster?: DagsterDeps;
  /** Test seam: skip the store read. */
  graph?: typeof assetGraph;
};

/**
 * The dataset's lineage, from dbt where that is possible. Never throws for a lineage reason: a
 * failure to reach Dagster downgrades to the registry graph.
 */
export async function datasetLineage(d: Dataset, deps: LineageDeps = {}): Promise<LineageGraph> {
  if (!config.dataProjectGit || !dagsterConfigured(deps.dagster)) return lineageFor(d);
  try {
    const [snapshot, graph] = await Promise.all([
      projectSnapshot(d.domain),
      (deps.graph ?? assetGraph)(deps.dagster),
    ]);
    if (!graph.ok) return lineageFor(d);
    const keys = datasetAssetKeys(snapshot, d.id);
    return graphLineage(d, graph.data, keys) ?? lineageFor(d);
  } catch {
    // A store or client slip must not cost the user their lineage view.
    return lineageFor(d);
  }
}
