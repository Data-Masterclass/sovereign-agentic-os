/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-50 migration plan, DRY RUN ONLY: which `connections/<catalog>/` files each domain repository
 * would gain from the existing live connection records, and which records cannot move and why.
 *
 *   node --import ./scripts/test-setup.mjs scripts/wp50-connections-to-git.ts <export.json>…
 *
 * An export is an array of connection records, or a `_search` response over the `os-connections`
 * index exported read-only by an operator. This script opens no connection and writes nothing;
 * there is no `--apply`. Once the plan is reviewed, the move is a normal save of each connection
 * (the store's writer commits it). No secret is read: records carry only the vault secret's name.
 * Exit 0 = every warehouse record can move; 1 = refusals listed; 2 = usage / unreadable input.
 */
import { readFileSync } from 'node:fs';
import { connectionsFromJson, planConnectionsMigration } from '@tabs/connections/lib/git/migrate-plan';

const args = process.argv.slice(2);
if (args.includes('--apply')) {
  console.error('wp50-connections-to-git: --apply is not supported; this script only plans (dry run).');
  process.exit(2);
}
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: wp50-connections-to-git.ts <export.json>…');
  process.exit(2);
}
let records;
try {
  records = files.flatMap((f) => connectionsFromJson(readFileSync(f, 'utf8')));
} catch (e) {
  console.error(`wp50-connections-to-git: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
const plan = planConnectionsMigration(records);
for (const d of plan.domains) console.log(JSON.stringify({ kind: 'domain', ...d }));
for (const r of plan.refused) console.log(JSON.stringify({ kind: 'refused', ...r }));
console.log(JSON.stringify({ kind: 'summary', mode: plan.mode, domains: plan.domains.length, refused: plan.refused.length, notCatalogs: plan.notCatalogs.length }));
process.exit(plan.refused.length ? 1 : 0);
