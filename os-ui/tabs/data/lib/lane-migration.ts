/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Record every existing dataset's personal-lane name (the lane-name migration plan)
 * USER STORY: As an operator I want each dataset to carry the name of the lane tables it really
 *             reads and writes, and to see every lane table two datasets share, before anything
 *             is changed — so that unique lane names arrive without renaming a live table.
 * ARCHITECTURE:
 *   - Pure: datasets in, a plan out. `scripts/record-lane-names.ts` feeds it an export and prints
 *     the plan (dry run, the default); with `--apply --out <file>` it writes the updated records
 *     to a FILE for an operator to load. It opens no connection and renames no table.
 *   - Recording is `laneSlug = laneSlug(d)`: for a dataset without one that is its legacy
 *     `physicalSlug`, the name its lane tables already have — so nothing moves.
 *   - A lane table two or more datasets map to (same owner, same slug, e.g. one name in two
 *     domains) is listed as a COLLISION: recording cannot split it; the owner decides which
 *     dataset the table belongs to, and the other rebuilds under a new lane name.
 */
import { parseDataset, serializeDataset, type Dataset, type Layer } from '@tabs/data/lib/dataset-schema';
import { laneSlug, personalSchema } from '@tabs/data/lib/store-fqn';

const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];

export type LaneRecordPlan = {
  dataset: string;
  name: string;
  owner: string;
  domain: string;
  tier: string;
  /** `record` = no lane name stored yet (it gets its legacy one); `keep` = already recorded;
   *  `skip` = a connected dataset (no personal lane). */
  action: 'record' | 'keep' | 'skip';
  laneSlug: string | null;
  /** The lane FQNs of the layers the registry says are built. */
  laneTables: string[];
};

export type LaneCollision = { table: string; datasets: { id: string; name: string; domain: string; tier: string }[] };

export type LanePlan = { datasets: LaneRecordPlan[]; collisions: LaneCollision[] };

export function planLaneRecords(datasets: Dataset[]): LanePlan {
  const plans: LaneRecordPlan[] = [];
  const byTable = new Map<string, LaneCollision['datasets']>();
  for (const d of datasets) {
    const base = { dataset: d.id, name: d.name, owner: d.owner, domain: d.domain, tier: d.tier };
    if (d.connected) {
      plans.push({ ...base, action: 'skip', laneSlug: null, laneTables: [] });
      continue;
    }
    const lane = laneSlug(d);
    const tables = LAYERS.filter((l) => d.versions[l]?.built).map((l) => `iceberg.${personalSchema(d.owner)}.${l}_${lane}`);
    plans.push({ ...base, action: d.laneSlug ? 'keep' : 'record', laneSlug: lane, laneTables: tables });
    for (const t of tables) byTable.set(t, [...(byTable.get(t) ?? []), { id: d.id, name: d.name, domain: d.domain, tier: d.tier }]);
  }
  const collisions = [...byTable].filter(([, ds]) => ds.length > 1).map(([table, ds]) => ({ table, datasets: ds }));
  return { datasets: plans, collisions };
}

/** The records to load on `--apply`: each dataset to record, re-serialized WITH its lane name. */
export function applyLaneRecords(datasets: Dataset[], plan: LanePlan): { id: string; yaml: string }[] {
  const wanted = new Map(plan.datasets.filter((p) => p.action === 'record').map((p) => [p.dataset, p.laneSlug!]));
  return datasets
    .filter((d) => wanted.has(d.id))
    .map((d) => {
      const yaml = serializeDataset({ ...d, laneSlug: wanted.get(d.id)! });
      if (parseDataset(yaml).laneSlug !== wanted.get(d.id)) throw new Error(`lane name for ${d.id} did not survive serialization`);
      return { id: d.id, yaml };
    });
}
