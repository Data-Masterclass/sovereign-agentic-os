/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dataset → Dagster asset keys, derived from the same planner that generates the project
 * USER STORY: As a maintainer I want the OS to name exactly the assets the `sovereign` code location
 *             defines for a dataset — the model keys `[<domain>, <model>]` (and a source's
 *             `[<domain>, <schema>, <table>]` when the tested layer was built out of band) — so a
 *             launch selects the right subset and read-back asks for the right checks.
 * ARCHITECTURE:
 *   - Pure over a `ProjectSnapshot`: `planModels` decides what is a model; this only maps names to
 *     keys. dagster-dbt's default translator keys a model by its name and a source by
 *     `[source_name, table]`; the location prefixes both with the domain (PrefixedTranslator).
 *   - "Downstream" = the dataset's own higher layers plus the models of datasets in the same domain
 *     whose `upstreams` name it (what `<model>+` would select within the repo).
 */
import type { Layer } from '@tabs/data/lib/dataset-schema';
import { planModels } from '@tabs/data/lib/dbt/models';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

const ORDER: Layer[] = ['bronze', 'silver', 'gold'];

export type DatasetAssetKeys = {
  /** Keys of the dataset's own models, lowest layer first. */
  models: { layer: Layer; name: string; key: string[] }[];
  /** The asset carrying the dataset's quality rules (a model, or the out-of-band source), or null. */
  tested: string[] | null;
  /** Models of OTHER datasets in the domain that read this one (direct dependents). */
  dependents: string[][];
};

export function datasetAssetKeys(snapshot: ProjectSnapshot, datasetId: string): DatasetAssetKeys {
  const plan = planModels(snapshot);
  const mine = plan.models
    .filter((m) => m.dataset.id === datasetId)
    .sort((a, b) => ORDER.indexOf(a.layer) - ORDER.indexOf(b.layer));
  const models = mine.map((m) => ({ layer: m.layer, name: m.name, key: [snapshot.domain, m.name] }));
  const testedModel = mine.find((m) => m.tested);
  let tested: string[] | null = testedModel ? [snapshot.domain, testedModel.name] : null;
  if (!tested) {
    // The tested layer was built out of band → the planner registered it as a source carrying the tests.
    const src = plan.sources.find((s) => s.meta?.os_dataset === datasetId && s.meta?.os_built === 'out-of-band' && s.columns);
    if (src) tested = [snapshot.domain, src.source, src.table];
  }
  const dependents = plan.models
    .filter((m) => m.dataset.id !== datasetId && (m.dataset.upstreams ?? []).some((u) => u.datasetId === datasetId))
    .map((m) => [snapshot.domain, m.name]);
  return { models, tested, dependents };
}

/** The subset a Build of `layer` launches: that layer, the dataset's higher models, and direct dependents. */
export function selectionForBuild(keys: DatasetAssetKeys, layer: Layer): string[][] {
  const from = ORDER.indexOf(layer);
  const own = keys.models.filter((m) => ORDER.indexOf(m.layer) >= from).map((m) => m.key);
  return dedupe([...own, ...keys.dependents]);
}

/** The subset a sync run launches: every model of the dataset plus direct dependents (`<landing>+`). */
export function selectionForSync(keys: DatasetAssetKeys): string[][] {
  return dedupe([...keys.models.map((m) => m.key), ...keys.dependents]);
}

function dedupe(keys: string[][]): string[][] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const s = k.join('/');
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}
