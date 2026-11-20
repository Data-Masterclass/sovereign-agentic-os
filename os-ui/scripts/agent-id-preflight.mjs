/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-53b N3 — read-only preflight: which committed agent systems would the strict
 *             identifier rule refuse? Must pass (exit 0) before AGENT_GRAPH_MODULE is switched on.
 * USER STORY: As the operator I want one command that reads every domain repository, lists every
 *             agent system whose agent ids, channels or tool names are not plain tokens, proposes
 *             the rename that fixes each, and changes nothing.
 * ARCHITECTURE:
 *   - Reads bare repos with git's own plumbing (`git ls-tree`, `git show`) at HEAD — read-only,
 *     the same bytes `git clone` gives. Each `agents/**\/system.yaml` goes through
 *     `tabs/agents/lib/module/preflight.ts` `preflightDoc` (plain YAML, so a definition the schema
 *     would refuse is still reported).
 *   - `--propose` also prints the rename (`proposeIdMigration`) for each refused system that
 *     parses; applying it is an ordinary governed save of that `system.yaml` (builder, MCP
 *     `commit_agent_files`), which versions and commits it like any edit.
 *   - Exit 0 = every system passes; 1 = at least one would be refused; 2 = usage or read error.
 *
 * USAGE (from os-ui/, in the os-ui pod or against a copy of the repos directory):
 *   node --experimental-strip-types scripts/agent-id-preflight.mjs [--repos-dir <dir>] [--propose] [--json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';

register('./test-alias-hook.mjs', import.meta.url);
const { preflightDoc, proposeIdMigration } = await import('../tabs/agents/lib/module/preflight.ts');
const { parseSystem, serializeSystem } = await import('../tabs/agents/lib/system-schema.ts');

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const reposDir = opt('--repos-dir') ?? process.env.REPOS_DIR ?? '/data/repos';
if (!existsSync(reposDir)) { console.error(`agent-id-preflight: no repos directory at ${reposDir} (give --repos-dir)`); process.exit(2); }

const git = (gitDir, ...args) => execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const findings = [];
let checked = 0;
for (const entry of readdirSync(reposDir).filter((e) => e.endsWith('.git')).sort()) {
  const gitDir = path.join(reposDir, entry);
  let paths;
  try {
    paths = git(gitDir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter((p) => /^agents\/(?:.+\/)?system\.yaml$/.test(p));
  } catch {
    continue; // an empty repository has no HEAD yet
  }
  for (const p of paths) {
    checked += 1;
    const text = git(gitDir, 'show', `HEAD:${p}`);
    const problems = preflightDoc(text);
    if (problems.length === 0) continue;
    const f = { repo: entry.replace(/\.git$/, ''), path: p, problems };
    if (argv.includes('--propose')) {
      try {
        const m = proposeIdMigration(parseSystem(text));
        f.proposal = { agents: m.agents, channels: m.channels, unresolved: m.unresolved, yaml: m.unresolved.length ? null : serializeSystem(m.system) };
      } catch (e) {
        f.proposal = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    findings.push(f);
  }
}
if (argv.includes('--json')) console.log(JSON.stringify({ checked, refused: findings.length, findings }, null, 2));
else {
  console.log(`agent-id-preflight: ${checked} system(s) checked in ${reposDir}, ${findings.length} would be refused`);
  for (const f of findings) {
    console.log(`  ${f.repo}:${f.path}: ${f.problems.join('; ')}`);
    if (f.proposal?.agents) console.log(`    rename agents ${JSON.stringify(f.proposal.agents)} channels ${JSON.stringify(f.proposal.channels)}${f.proposal.unresolved.length ? ` — UNRESOLVED: ${f.proposal.unresolved.join('; ')}` : ''}`);
  }
}
process.exit(findings.length ? 1 : 0);
