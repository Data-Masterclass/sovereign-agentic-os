/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Record each dataset's personal-lane name (tabs/data/lib/lane-migration.ts). DRY RUN by default.
 *
 *   node --import ./scripts/test-setup.mjs scripts/record-lane-names.ts <export.json>…
 *   node --import ./scripts/test-setup.mjs scripts/record-lane-names.ts --apply --out <records.json> <export.json>…
 *
 * An export is any of: an array of dataset objects (MCP `get_dataset` output), an array of store
 * records (`{ yaml }`), or a search response over the datasets index exported read-only by an
 * operator (`hits.hits[]._source.yaml`). The dry run prints one JSON line per dataset and per
 * collision. `--apply` additionally writes the updated `{ id, yaml }` records to `--out`; it opens
 * no connection itself — loading that file into the datasets index is a separate, reviewed step.
 * No table is renamed. Exit 0 = no collision; exit 1 = collisions listed; exit 2 = usage / input.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { datasetsFromJson } from '@tabs/data/lib/dbt/literal-preflight';
import { applyLaneRecords, planLaneRecords } from '@tabs/data/lib/lane-migration';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const files = args.filter((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1));
if (!files.length || (apply && !out)) {
  console.error('usage: record-lane-names.ts [--apply --out <records.json>] <export.json>…');
  process.exit(2);
}
let datasets;
try {
  datasets = files.flatMap((f) => datasetsFromJson(readFileSync(f, 'utf8')));
} catch (e) {
  console.error(`record-lane-names: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
const plan = planLaneRecords(datasets);
for (const p of plan.datasets) console.log(JSON.stringify({ kind: 'dataset', ...p }));
for (const c of plan.collisions) console.log(JSON.stringify({ kind: 'collision', ...c }));
const toRecord = plan.datasets.filter((p) => p.action === 'record').length;
if (apply) {
  writeFileSync(out!, JSON.stringify(applyLaneRecords(datasets, plan), null, 2));
  console.error(`record-lane-names: wrote ${toRecord} record(s) to ${out} (not loaded — load them as a separate step)`);
} else {
  console.error(`record-lane-names: DRY RUN — ${datasets.length} dataset(s), ${toRecord} to record, ${plan.collisions.length} lane table(s) shared by 2+ datasets. Nothing written.`);
}
process.exit(plan.collisions.length ? 1 : 0);
