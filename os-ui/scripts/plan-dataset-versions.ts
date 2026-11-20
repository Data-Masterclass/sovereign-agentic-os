/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-37 migration plan for the retired dataset version log. DRY RUN ONLY — there is no apply.
 *
 *   node --import ./scripts/test-setup.mjs scripts/plan-dataset-versions.ts <datasets.json> <os-versions-dataset.json>
 *
 * Inputs are read-only exports made by an operator: the datasets (any form `datasetsFromJson`
 * reads, archived included) and a search export of the `os-versions-dataset` index. Prints one JSON
 * line per record and per dataset, then a summary (tabs/data/lib/version-migration.ts). It opens no
 * connection, writes no file, drops no index and changes no table. `--apply` is refused.
 * Exit 0 = plan printed; 1 = at least one dataset is on a shared table (needs a rebuild first); 2 = usage.
 */
import { readFileSync } from 'node:fs';
import { datasetsFromJson } from '@tabs/data/lib/dbt/literal-preflight';
import { planVersionMigration, recordsFromJson } from '@tabs/data/lib/version-migration';

const args = process.argv.slice(2);
if (args.includes('--apply')) {
  console.error('plan-dataset-versions: there is no apply step. Retiring the index is a separate, reviewed operator action.');
  process.exit(2);
}
if (args.length !== 2) {
  console.error('usage: plan-dataset-versions.ts <datasets.json> <os-versions-dataset.json>');
  process.exit(2);
}
let plan;
try {
  plan = planVersionMigration(datasetsFromJson(readFileSync(args[0], 'utf8')), recordsFromJson(readFileSync(args[1], 'utf8')));
} catch (e) {
  console.error(`plan-dataset-versions: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
for (const r of plan.records) console.log(JSON.stringify({ kind: 'record', ...r }));
for (const d of plan.datasets) console.log(JSON.stringify({ kind: 'dataset', ...d }));
console.error(`plan-dataset-versions: DRY RUN — ${JSON.stringify(plan.summary)}. Nothing written.`);
process.exit(plan.summary.sharedTable ? 1 : 0);
