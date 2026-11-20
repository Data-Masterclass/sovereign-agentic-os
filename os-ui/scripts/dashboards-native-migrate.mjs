// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// AREA:       repo tooling — WP-52 migration, DRY RUN ONLY
// FEATURE:    Print what turning DASHBOARDS_NATIVE on would commit for one domain checkout.
// USER STORY: As the owner I want the file-by-file plan for the live dashboards before the switch.
// ARCHITECTURE:
//   - Reads a plain checkout (or an exported tree) from disk; never touches a repository, a store
//     or the cluster. `--apply` is refused: the migration is the first commit with the flag on.
//   - Run from os-ui/:  node --import ./scripts/test-setup.mjs scripts/dashboards-native-migrate.mjs \
//                         --domain <domain> --repo <checkout> [--json]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--apply')) {
  console.error('dashboards-native-migrate: --apply is not supported. This tool only plans; the migration is the first commit with DASHBOARDS_NATIVE=true.');
  process.exit(2);
}
const repo = opt('--repo');
const domain = opt('--domain');
if (!repo || !domain) {
  console.error('usage: dashboards-native-migrate.mjs --domain <domain> --repo <checkout> [--json]   (dry run only)');
  process.exit(2);
}
const tree = new Map();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'target') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(ya?ml|json|md)$/.test(e.name)) tree.set(path.relative(repo, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
  }
};
walk(repo);
const { planNativeMigration } = await import('@tabs/dashboards/lib/git/migrate');
const plan = planNativeMigration(domain, tree);
if (args.includes('--json')) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(`DRY RUN — domain ${plan.domain}: ${plan.dashboards.length} dashboard(s); nothing was written.`);
  for (const d of plan.dashboards) {
    console.log(`\n${d.name} (${d.id}) from ${d.from}`);
    for (const p of d.panels) console.log(`  ${p.id}: ${p.savedQuery ? `saved query ${p.savedQuery}` : `PENDING — ${p.pending}`}`);
  }
  for (const [k, list] of [['add', plan.add], ['modify', plan.modify], ['delete', plan.delete]]) for (const f of list) console.log(`${k.padEnd(6)} ${f}`);
  for (const r of plan.refused) console.log(`REFUSED ${r.file}: ${r.reason}`);
}
