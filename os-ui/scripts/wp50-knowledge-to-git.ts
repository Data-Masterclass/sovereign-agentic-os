/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-50 migration plan, DRY RUN ONLY: which `knowledge/` OKF files each domain repository would
 * gain from the existing live workflow records, and which records cannot move and why.
 *
 *   node --import ./scripts/test-setup.mjs scripts/wp50-knowledge-to-git.ts <export.json>…
 *
 * An export is an array of workflow records, or a `_search` response over `os-knowledge-records`
 * exported read-only by an operator. This script opens no connection and writes nothing; there is
 * no `--apply`. After review, the move is one normal save per domain (the store's writer commits),
 * or the boot read-back once a bundle exists. Personal drafts are counted, never planned.
 * Exit 0 = every shared record can move; 1 = refusals listed; 2 = usage / unreadable input.
 */
import { readFileSync } from 'node:fs';
import { knowledgeRecordsFromJson, planKnowledgeMigration } from '@tabs/knowledge/lib/git/migrate-plan';

const args = process.argv.slice(2);
if (args.includes('--apply')) {
  console.error('wp50-knowledge-to-git: --apply is not supported; this script only plans (dry run).');
  process.exit(2);
}
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: wp50-knowledge-to-git.ts <export.json>…');
  process.exit(2);
}
let records;
try {
  records = files.flatMap((f) => knowledgeRecordsFromJson(readFileSync(f, 'utf8')));
} catch (e) {
  console.error(`wp50-knowledge-to-git: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
const plan = planKnowledgeMigration(records);
for (const d of plan.domains) console.log(JSON.stringify({ kind: 'domain', ...d }));
for (const r of plan.refused) console.log(JSON.stringify({ kind: 'refused', ...r }));
console.log(JSON.stringify({ kind: 'summary', mode: plan.mode, domains: plan.domains.length, refused: plan.refused.length, personal: plan.personal, archived: plan.archived, manual: plan.manual }));
process.exit(plan.refused.length ? 1 : 0);
