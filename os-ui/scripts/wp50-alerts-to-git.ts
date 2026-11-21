/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-50 (alerts) migration plan, DRY RUN ONLY: which `metrics/alerts/*.yml` each domain repository
 * would gain from the existing `os-alert-rules` records, and which rules cannot move and why.
 *
 *   node --import ./scripts/test-setup.mjs scripts/wp50-alerts-to-git.ts <export.json> [--repos <dir>]
 *
 * An export is an array of alert rule records, or a `_search` response over `os-alert-rules`
 * exported read-only by an operator. `--repos` is a local directory of domain repositories (e.g. a
 * read-only copy); each domain's committed dbt YAML at HEAD resolves members to dbt metrics. Without
 * it every rule is pending. This script opens no connection and writes nothing; there is no
 * `--apply`. With `OS_ALERTS_NATIVE` on, the next save in a domain commits its alerts.
 * Exit 0 = every rule can move; 1 = pending or refused rules listed; 2 = usage / unreadable input.
 */
import { readFileSync } from 'node:fs';
import { listTree, log, readBlob } from '@core/infra/git-store';
import { alertRulesFromJson, planAlertMigration } from '@tabs/metrics/lib/git/alerts-migrate-plan';

const args = process.argv.slice(2);
if (args.includes('--apply')) {
  console.error('wp50-alerts-to-git: --apply is not supported; this script only plans (dry run).');
  process.exit(2);
}
const ri = args.indexOf('--repos');
const reposDir = ri >= 0 ? args[ri + 1] : '';
const files = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
if (!files.length) {
  console.error('usage: wp50-alerts-to-git.ts <export.json> [--repos <dir>]');
  process.exit(2);
}
let input;
try {
  const parsed = files.map((f) => alertRulesFromJson(readFileSync(f, 'utf8')));
  input = { rules: parsed.flatMap((p) => p.rules), refused: parsed.flatMap((p) => p.refused) };
} catch (e) {
  console.error(`wp50-alerts-to-git: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
const dbt = new Map<string, Map<string, string>>();
for (const domain of new Set(input.rules.map((r) => r.domain))) {
  const m = new Map<string, string>();
  if (reposDir) {
    const sha = (await log(domain, { reposDir, limit: 1 }))[0]?.sha;
    if (sha) for (const e of await listTree(domain, sha, { reposDir })) if (/(^|\/)models\/.*\.ya?ml$/.test(e.path)) m.set(e.path, await readBlob(domain, sha, e.path, { reposDir }));
  }
  dbt.set(domain, m);
}
const plan = planAlertMigration(input.rules, input.refused, (d) => dbt.get(d) ?? new Map());
for (const d of plan.domains) console.log(JSON.stringify({ kind: 'domain', ...d }));
for (const p of plan.pending) console.log(JSON.stringify({ kind: 'pending', ...p }));
for (const r of plan.refused) console.log(JSON.stringify({ kind: 'refused', ...r }));
console.log(JSON.stringify({ kind: 'summary', mode: plan.mode, domains: plan.domains.length, files: plan.domains.reduce((n, d) => n + d.files.length, 0), pending: plan.pending.length, refused: plan.refused.length }));
process.exit(plan.pending.length || plan.refused.length ? 1 : 0);
