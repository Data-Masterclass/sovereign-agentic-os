/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53b N3 — the identifier preflight over real repos, and the proposed migration
 * USER STORY: As the operator I want the preflight to fail on exactly the systems the strict rule
 *             would refuse, and the proposed rename to produce a system that passes, compiles and
 *             generates — so flag-on cannot strand a live team.
 * ARCHITECTURE:
 *   - Real bare git repos written by `core/infra/git-store.ts`; the CLI runs as a child process with
 *     `--repos-dir` and reads them with git itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitTree, openOrInit } from '@core/infra/git-store';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { identifierProblems } from '@tabs/agents/lib/safe-ids';
import { preflightDoc, proposeIdMigration } from '@tabs/agents/lib/module/preflight';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';

const OS_UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const GOOD = `version: '1'
system: { name: Good, domain: sales, visibility: Shared }
entrypoint: lead
state: { channels: { messages: add_messages, done: boolean } }
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge], connections: [] }
agents:
  - { id: lead, role: r, agent_md: '# lead', memory_md: '', tools: [], members: [worker] }
  - { id: worker, role: w, agent_md: '# worker', memory_md: '', tools: [search_knowledge] }
edges:
  - { from: lead, to: worker, type: supervise }
`;
// Legacy ids the strict rule refuses: upper case, a space, a dot; a camelCase channel a guard reads.
const LEGACY = `version: '1'
system: { name: Legacy, domain: sales, visibility: Shared }
entrypoint: Lead Analyst
state: { channels: { messages: add_messages, planReady: boolean } }
grants: { data: [], knowledge: [], metrics: [], tools: [search_knowledge], connections: [] }
agents:
  - { id: Lead Analyst, role: r, agent_md: '# lead', memory_md: '', tools: [], members: [Data.Researcher] }
  - { id: Data.Researcher, role: w, agent_md: '# r', memory_md: '', tools: [search_knowledge] }
  - { id: writer, role: w, agent_md: '# w', memory_md: '', tools: [search_knowledge] }
edges:
  - { from: Lead Analyst, to: Data.Researcher, type: supervise }
  - { from: Data.Researcher, to: writer, type: handoff, when: 'state.planReady == true' }
ui: { positions: { Lead Analyst: { x: 1, y: 2 } } }
`;

function runCli(reposDir: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/agent-id-preflight.mjs', '--repos-dir', reposDir, ...args], { cwd: OS_UI, encoding: 'utf8' });
}

test('preflight: passes a clean repo, lists exactly the refused systems, changes nothing', async () => {
  const reposDir = mkdtempSync(path.join(os.tmpdir(), 'wp53-preflight-'));
  const author = { name: 'os', email: 'os@example.invalid' };
  await openOrInit('sales', { reposDir });
  await commitTree('sales', new Map([['agents/good/system.yaml', GOOD]]), { reposDir, author, message: 'good' });
  const clean = runCli(reposDir);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /1 system\(s\) checked.*0 would be refused/);

  await openOrInit('kiekert', { reposDir });
  const { sha } = await commitTree('kiekert', new Map([['agents/good/system.yaml', GOOD], ['agents/legacy/system.yaml', LEGACY]]), { reposDir, author, message: 'legacy' });
  const r = runCli(reposDir, '--propose', '--json');
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout) as { checked: number; refused: number; findings: { repo: string; path: string; problems: string[]; proposal: { yaml: string | null } }[] };
  assert.equal(out.checked, 3);
  assert.deepEqual(out.findings.map((f) => `${f.repo}:${f.path}`), ['kiekert:agents/legacy/system.yaml']);
  assert.ok(out.findings[0].problems.some((p) => p.includes('Lead Analyst')));
  assert.ok(out.findings[0].problems.some((p) => p.includes('planReady')));
  // Read-only: the repo HEAD is unchanged.
  const head = spawnSync('git', ['--git-dir', path.join(reposDir, 'kiekert.git'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(head, sha);

  // The proposal passes the preflight, compiles and generates.
  const fixed = out.findings[0].proposal.yaml!;
  assert.deepEqual(preflightDoc(fixed), []);
  const sys = parseSystem(fixed);
  assert.deepEqual(identifierProblems(sys), []);
  const ir = compile(sys);
  assert.equal(ir.entrypoint, 'lead-analyst');
  assert.deepEqual(ir.commands, [{ from: 'data-researcher', to: 'writer', when: 'state.planready == true' }]);
  assert.deepEqual(Object.keys(sys.state.channels).sort(), ['messages', 'planready']);
  assert.deepEqual(Object.keys(sys.ui?.positions ?? {}), ['lead-analyst']);
  generateAgentModule({ id: 'sys_legacy1', slug: 'legacy', sys, ...hostModuleInputs() });

  // Applying it (a governed save of the new yaml, here: a commit) makes the preflight pass.
  await commitTree('kiekert', new Map([['agents/good/system.yaml', GOOD], ['agents/legacy/system.yaml', fixed]]), { reposDir, author, message: 'migrated ids' });
  assert.equal(runCli(reposDir).status, 0);
});

test('proposeIdMigration: deduplicates, never emits a reserved name, and reports what it cannot rename', () => {
  const sys = parseSystem(GOOD);
  sys.agents.push({ id: 'Lead', role: 'x', agent_md: '', memory_md: '' }, { id: '__proto__', role: 'x', agent_md: '', memory_md: '' });
  sys.agents[0].members = ['worker', 'Lead', '__proto__'];
  sys.grants.tools.push('Bad Tool');
  const m = proposeIdMigration(sys);
  const ids = m.system.agents.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'unique');
  assert.ok(!ids.includes('__proto__'));
  assert.equal(m.agents.Lead, 'lead_2');
  assert.ok(m.unresolved.some((u) => u.includes('Bad Tool')), 'a refused tool name is listed, not invented');
  assert.equal(serializeSystem(sys).includes('Bad Tool'), true, 'the input is not mutated');
});
