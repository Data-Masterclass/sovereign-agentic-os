/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53b N3 — the identifier preflight over EVERY definition: git HEAD and the store
 * USER STORY: As the operator I want one read-only command, inside the running image, that tells me
 *             whether switching `AGENT_GRAPH_MODULE` on would refuse any team — whether its
 *             definition is committed or lives only in the OS store — and proposes the fix.
 * ARCHITECTURE:
 *   - `runPreflight({ reposDir, store })`: every `agents/**\/system.yaml` at HEAD of every domain
 *     repo under `reposDir` (read with `core/infra/git-store.ts`, the same reader the OS uses —
 *     no git binary needed), plus every store definition (`readSystemDefinitionsReadOnly`), each
 *     through `preflightDoc`. A proposal (`proposeIdMigration`) per refused definition that parses.
 *   - `main()` (worker/agent-id-preflight.mjs): reads `config.reposDir` (`OS_REPOS_DIR`), reads the
 *     store's durable mirror READ-ONLY (`readSystemDefinitionsReadOnly`: `_count`/`_search` only)
 *     and REFUSES to report a pass when it did not answer completely (exit 2). `--repos-only` checks git alone and says so.
 *     Exit 0 = every definition passes; 1 = at least one would be refused; 2 = could not check.
 *   - Read-only: nothing is written anywhere.
 */
import { config } from '@core/kernel/config';
import { listRepos, listTree, readBlob } from '@core/infra/git-store';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { preflightDoc, proposeIdMigration } from '@tabs/agents/lib/module/preflight';

export type PreflightFinding = {
  source: 'git' | 'store';
  domain: string;
  where: string;
  problems: string[];
  proposal?: { agents: Record<string, string>; channels: Record<string, string>; unresolved: string[]; yaml: string | null } | { error: string };
};
/** Per domain (WP-53d): what was checked and what would be refused — the answer for one allowlist entry. */
export type DomainPreflight = { git: number; store: number; refused: number };
export type PreflightReport = { checked: { git: number; store: number | null }; refused: number; findings: PreflightFinding[]; byDomain: Record<string, DomainPreflight> };

const SYSTEM_YAML = /^agents\/(?:.+\/)?system\.yaml$/;

function finding(source: 'git' | 'store', domain: string, where: string, yaml: string, propose: boolean): PreflightFinding | null {
  const problems = preflightDoc(yaml);
  if (problems.length === 0) return null;
  const f: PreflightFinding = { source, domain, where, problems };
  if (propose) {
    try {
      const m = proposeIdMigration(parseSystem(yaml));
      f.proposal = { agents: m.agents, channels: m.channels, unresolved: m.unresolved, yaml: m.unresolved.length ? null : serializeSystem(m.system) };
    } catch (e) {
      f.proposal = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return f;
}

export async function runPreflight(input: {
  reposDir: string;
  /** The store's definitions; `null` = not checked (`--repos-only`). */
  store: { id: string; domain: string; yaml: string; archived: boolean }[] | null;
  propose?: boolean;
}): Promise<PreflightReport> {
  const findings: PreflightFinding[] = [];
  const byDomain: Record<string, DomainPreflight> = {};
  const tally = (domain: string, kind: 'git' | 'store', refused: boolean) => {
    const d = (byDomain[domain] ??= { git: 0, store: 0, refused: 0 });
    d[kind] += 1;
    if (refused) d.refused += 1;
  };
  let git = 0;
  for (const repo of await listRepos({ reposDir: input.reposDir })) {
    if (!repo.head) continue;
    for (const e of await listTree(repo.name, undefined, { reposDir: input.reposDir })) {
      if (!SYSTEM_YAML.test(e.path)) continue;
      git += 1;
      const f = finding('git', repo.name, `${repo.name}:${e.path}`, await readBlob(repo.name, undefined, e.path, { reposDir: input.reposDir }), !!input.propose);
      tally(repo.name, 'git', !!f);
      if (f) findings.push(f);
    }
  }
  for (const r of input.store ?? []) {
    const f = finding('store', r.domain, `${r.domain}:${r.id}${r.archived ? ' (archived)' : ''}`, r.yaml, !!input.propose);
    tally(r.domain, 'store', !!f);
    if (f) findings.push(f);
  }
  const sorted = Object.fromEntries(Object.entries(byDomain).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { checked: { git, store: input.store ? input.store.length : null }, refused: findings.length, findings, byDomain: sorted };
}

/**
 * `--domains test,sales` (or `--domains=test`): the domains about to be put in
 * AGENT_GRAPH_MODULE_DOMAINS. The report still lists every domain; the EXIT CODE then counts only
 * refusals in those domains. Absent or "*" ⇒ every domain. `null` = the option was given empty.
 */
export function parseDomainsArg(argv: string[]): string[] | 'all' | null {
  const i = argv.findIndex((a) => a === '--domains' || a.startsWith('--domains='));
  if (i < 0) return 'all';
  const raw = argv[i].startsWith('--domains=') ? argv[i].slice('--domains='.length) : (argv[i + 1] ?? '');
  const list = raw.split(',').map((d) => d.trim()).filter((d) => d && !d.startsWith('--'));
  if (list.length === 0) return null;
  return list.includes('*') ? 'all' : list;
}

/** Refusals that count for the exit code: every domain, or only the ones being enabled. */
export function refusedIn(report: PreflightReport, domains: string[] | 'all'): number {
  return domains === 'all' ? report.refused : report.findings.filter((f) => domains.includes(f.domain)).length;
}

/** The command (`node --experimental-strip-types worker/agent-id-preflight.mjs`). Returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const scope = parseDomainsArg(argv);
  if (scope === null) {
    console.error('agent-id-preflight: --domains needs a value (e.g. --domains test, or "*" for every domain)');
    return 2;
  }
  const reposOnly = argv.includes('--repos-only');
  let store: { id: string; domain: string; yaml: string; archived: boolean }[] | null = null;
  if (!reposOnly) {
    // READ-ONLY: the mirror is read with `_count`/`_search` only — no hydration of a registry, no
    // crash recovery, no index bootstrap — so running the preflight changes nothing anywhere.
    const { readSystemDefinitionsReadOnly } = await import('@tabs/agents/lib/store');
    store = await readSystemDefinitionsReadOnly();
    if (store === null) {
      console.error('agent-id-preflight: the agent store\'s durable mirror did not give a complete answer — store definitions were NOT checked. Fix the mirror, or pass --repos-only to check git alone.');
      return 2;
    }
  }
  let report: PreflightReport;
  try {
    report = await runPreflight({ reposDir: config.reposDir, store, propose: argv.includes('--propose') });
  } catch (e) {
    console.error(`agent-id-preflight: could not read the repositories in ${config.reposDir} (OS_REPOS_DIR): ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const counted = refusedIn(report, scope);
  if (argv.includes('--json')) console.log(JSON.stringify({ reposDir: config.reposDir, ...report, scope, refusedInScope: counted }, null, 2));
  else {
    console.log(`agent-id-preflight: ${report.checked.git} committed and ${report.checked.store ?? 'NOT CHECKED'} store definition(s) in ${config.reposDir}; ${report.refused} would be refused`);
    for (const [domain, d] of Object.entries(report.byDomain)) {
      console.log(`  domain ${domain}: ${d.git} committed, ${d.store} in the store — ${d.refused ? `${d.refused} would be refused` : 'ready for AGENT_GRAPH_MODULE_DOMAINS'}`);
    }
    for (const f of report.findings) console.log(`  [${f.source}] ${f.where}: ${f.problems.join('; ')}`);
    if (scope !== 'all') {
      const missing = scope.filter((d) => !report.byDomain[d]);
      console.log(`agent-id-preflight: exit code covers ${scope.join(', ')} only — ${counted} would be refused there${missing.length ? ` (no definitions found in: ${missing.join(', ')})` : ''}`);
    }
  }
  return counted ? 1 : 0;
}
