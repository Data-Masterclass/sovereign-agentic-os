/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-37 migration plan for the retired dataset version log. DRY RUN ONLY — there is no apply.
 *
 *   node --import ./scripts/test-setup.mjs scripts/plan-dataset-versions.ts <datasets.json> <os-versions-dataset.json> [--repo <domain-repo-clone>]…
 *
 * A record is marked superseded by git only when a `--repo` clone's own log (read with `git log`,
 * read-only) proves it; with no `--repo` every record is `kept-unverified`.
 * Inputs are read-only exports made by an operator: the datasets (any form `datasetsFromJson`
 * reads, archived included) and a search export of the `os-versions-dataset` index. Prints one JSON
 * line per record and per dataset, then a summary (tabs/data/lib/version-migration.ts). It opens no
 * connection, writes no file, drops no index and changes no table. `--apply` is refused. The
 * `os-versions-dataset` index is never deleted: it stays readable as the legacy view.
 * Exit 0 = plan printed; 1 = at least one dataset is on a shared table (needs a rebuild first); 2 = usage.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { datasetsFromJson } from '@tabs/data/lib/dbt/literal-preflight';
import { gitEvidenceFromLog, planVersionMigration, recordsFromJson } from '@tabs/data/lib/version-migration';

const args = process.argv.slice(2);
if (args.includes('--apply')) {
  console.error('plan-dataset-versions: there is no apply step. Retiring the index is a separate, reviewed operator action.');
  process.exit(2);
}
const repos: string[] = [];
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo') repos.push(args[++i] ?? '');
  else files.push(args[i]);
}
if (files.length !== 2 || repos.some((r) => !r)) {
  console.error('usage: plan-dataset-versions.ts <datasets.json> <os-versions-dataset.json> [--repo <domain-repo-clone>]…');
  process.exit(2);
}
let plan;
try {
  const git = new Map<string, string[]>();
  for (const repo of repos) {
    gitEvidenceFromLog(execFileSync('git', ['-C', repo, 'log', '--all', '--format=%cI%x1f%B%x1e'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }), git);
  }
  plan = planVersionMigration(datasetsFromJson(readFileSync(files[0], 'utf8')), recordsFromJson(readFileSync(files[1], 'utf8')), git);
} catch (e) {
  console.error(`plan-dataset-versions: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
for (const r of plan.records) console.log(JSON.stringify({ kind: 'record', ...r }));
for (const d of plan.datasets) console.log(JSON.stringify({ kind: 'dataset', ...d }));
console.error(`plan-dataset-versions: DRY RUN — ${JSON.stringify(plan.summary)}. Nothing written.`);
process.exit(plan.summary.sharedTable ? 1 : 0);
