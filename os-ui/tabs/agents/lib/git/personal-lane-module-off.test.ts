/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A personal agent lane (the owner's user repo) holds the native LangGraph module for the
 *             systems whose OWN domain has the module flag on, and the plain files for the rest
 * USER STORY: As a creator in `sales` I want my personal agent in my own repo to be real LangGraph
 *             code, like the agents in the domain repo, while a system of another domain in the same
 *             lane follows that domain's flag.
 * ARCHITECTURE:
 *   - The real commit path (`commitAgentSystem`) over a temp `reposDir`; read back with `git`.
 *   - AGENT_GRAPH_MODULE=false (env before import).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AGENT_GRAPH_MODULE = 'false';
process.env.AGENT_GRAPH_MODULE_DOMAINS = 'sales';

const { ensureV2Repo, repoPath } = await import('@core/infra/git-store');
const { commitAgentSystem, __setAgentProjectGitForTests } = await import('@tabs/agents/lib/git/commit');
const { userRepoName } = await import('@core/infra/repo-layout');
const { parseSystem, serializeSystem } = await import('@tabs/agents/lib/system-schema');
type SnapshotSystem = import('@tabs/agents/lib/git/snapshot').SnapshotSystem;

const ALICE = { id: 'alice@example.com', name: 'Alice', email: 'alice@example.com' };
const yamlIn = (domain: string, name: string) => serializeSystem(parseSystem({
  version: '1',
  system: { name, domain, visibility: 'Personal' },
  runtime: 'langgraph',
  entrypoint: 'analyst',
  grants: { tools: ['search_knowledge'] },
  agents: [{ id: 'analyst', role: 'agent', agent_md: 'You analyse.', memory_md: '' }],
}));
const sys = (id: string, name: string, domain: string): SnapshotSystem => ({
  id, name, domain, owner: ALICE.id, visibility: 'Personal', origin: 'authored', running: false,
  schedule: { kind: 'manual' }, disabledAgents: [], folder: '/', version: 1, yaml: yamlIn(domain, name),
} as SnapshotSystem);
const git = (gitdir: string, args: string[]) => execFileSync('git', ['--git-dir', gitdir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } });

test('twin, flag off: the lane holds no module for any system', async () => {
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-module-off-'));
  __setAgentProjectGitForTests(true);
  await ensureV2Repo('sales', { reposDir });
  const systems = [sys('sys_sales1', 'Sales pricing', 'sales'), sys('sys_mktg1', 'Mktg copy', 'marketing')];
  await commitAgentSystem('sales', ALICE, { action: 'create system', object: 'sales-pricing' }, { reposDir, mirror: false, captured: systems, allSystems: () => systems });
  const files = git(repoPath(userRepoName(ALICE.id), { reposDir }), ['ls-tree', '-r', '--name-only', 'main']).split('\n');
  assert.ok(files.includes('agents/sales-pricing/graph.json'), files.join(','));
  assert.ok(files.includes('agents/mktg-copy/graph.json'));
  assert.equal(files.some((f) => f.endsWith('/graph.mjs')), false, 'flag off: no module anywhere');
});
