/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    WP-53 migration — with `AGENT_GRAPH_MODULE` on, a domain's agent subtree becomes the
 *             native module layout in ONE commit, `system.yaml` is OS metadata only, and the OS
 *             loads what that commit holds
 * USER STORY: As the owner I want switching the flag on to rewrite each domain repo's agents once,
 *             visibly, as one commit; I want the committed `system.yaml` to say who owns the team and
 *             what it may use, but nothing about how the graph runs; and I want a push of that file
 *             never to wipe the team.
 * ARCHITECTURE:
 *   - Pure generator in, real git out: `generateAgentFiles(snapshot, { module })` → `commitTree`
 *     into a REAL repository (`core/infra/git-store.ts`), read back at the commit and loaded through
 *     the hash check.
 *   - `UPDATE_GOLDEN=1` rewrites `module/fixtures/agents-module-domain.golden.json`, which is also
 *     the GLUE-10 fixture for this generator (`scripts/glue/generators.d/agent-module.json`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { commitTree, openOrInit } from '@core/infra/git-store';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { generateAgentFiles } from '@tabs/agents/lib/git/generate';
import type { AgentProjectSnapshot, SnapshotSystem } from '@tabs/agents/lib/git/snapshot';
import { isOsLayerSystemYaml } from '@tabs/agents/lib/git/ingest';
import { generateAgentModule } from '@tabs/agents/lib/module/generate';
import { hostModuleInputs } from '@tabs/agents/lib/module/versions';
import { loadAgentModule, readCommittedModule } from '@core/adapters/agent-module/load';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const goldenOf = (f: string) => JSON.parse(readFileSync(path.join(HERE, '../git/fixtures', f), 'utf8')) as Record<string, string>;
const TEAM_YAML = goldenOf('shared-supervisor-team.golden.json')['agents/revenue-review/system.yaml'];
const PERSONAL_YAML = goldenOf('personal-single-agent.golden.json')['agents/personal/1574ad62d48a/support-triage/system.yaml'];
const GOLDEN = path.join(HERE, 'fixtures/agents-module-domain.golden.json');

const sys = (over: Partial<SnapshotSystem> & Pick<SnapshotSystem, 'id' | 'name' | 'owner' | 'visibility' | 'yaml'>): SnapshotSystem => ({
  origin: 'authored',
  running: false,
  schedule: { kind: 'manual' },
  disabledAgents: [],
  folder: '/',
  version: 1,
  ...over,
} as SnapshotSystem);

const SNAPSHOT: AgentProjectSnapshot = {
  domain: 'sales',
  systems: [
    sys({ id: 'sys_aaa111', name: 'Support triage', owner: 'amir@example.com', visibility: 'Personal', yaml: PERSONAL_YAML }),
    sys({ id: 'sys_bbb222', name: 'Revenue review', owner: 'bea@example.com', visibility: 'Shared', yaml: TEAM_YAML, disabledAgents: ['publisher'] }),
  ],
};

test('flag on: each system directory is the native module; system.yaml holds OS metadata only', () => {
  const files = generateAgentFiles(SNAPSHOT, { module: hostModuleInputs() });
  const dirs = [...files.keys()].filter((p) => p.endsWith('/graph.mjs')).map((p) => p.replace(/\/graph\.mjs$/, ''));
  assert.equal(dirs.length, 2);
  for (const dir of dirs) {
    const own = [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort();
    assert.ok(own.includes('run.mjs') && own.includes('package.json') && own.includes('evals/cases.json') && own.includes('README.md'), own.join(','));
    assert.ok(own.some((p) => p.startsWith('prompts/')), 'prompts/ is written');
    assert.equal(own.includes('graph.json'), false, 'graph.mjs replaces graph.json');
    assert.equal(own.some((p) => p.startsWith('agents/')), false, 'prompts/ replaces agents/<id>.md');
    const yamlText = files.get(`${dir}/system.yaml`)!;
    assert.equal(isOsLayerSystemYaml(yamlText), true);
    const doc = load(yamlText) as Record<string, unknown>;
    for (const k of ['entrypoint', 'edges', 'state']) assert.equal(k in doc, false, `${dir}: system.yaml carries no '${k}'`);
    for (const a of doc.agents as Record<string, unknown>[]) {
      for (const k of ['agent_md', 'memory_md', 'members', 'tools']) assert.equal(k in a, false, `${dir}: no agent '${k}' in system.yaml`);
    }
    assert.ok('grants' in doc && 'system' in doc && 'safety_preset' in doc);
    assert.match(files.get(`${dir}/README.md`)!, /## Run it without the OS/);
  }
  // A disabled agent is not in the graph.
  const team = files.get('agents/revenue-review/graph.mjs')!;
  assert.equal(team.includes('"id": "publisher"'), false);
  assert.equal(files.has('agents/revenue-review/prompts/publisher.md'), false);

  const golden = Object.fromEntries(files);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
  assert.deepEqual(golden, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});

test('flag off: the subtree is exactly what it was (the committed goldens are unchanged)', () => {
  const off = generateAgentFiles(SNAPSHOT);
  assert.ok([...off.keys()].some((p) => p.endsWith('/graph.json')));
  assert.equal([...off.keys()].some((p) => p.endsWith('/graph.mjs')), false);
});

test('migration: one commit per repo turns on the module, a regeneration commits nothing, and the OS loads that commit', async () => {
  const reposDir = mkdtempSync(path.join(os.tmpdir(), 'wp53-migrate-'));
  const author = { name: 'os', email: 'os@example.invalid' };
  await openOrInit('sales', { reposDir });
  const v1 = await commitTree('sales', generateAgentFiles(SNAPSHOT), { reposDir, author, message: 'agents: v1 layout' });
  const migrated = await commitTree('sales', generateAgentFiles(SNAPSHOT, { module: hostModuleInputs() }), { reposDir, author, message: 'agents: native LangGraph modules (WP-53)' });
  assert.equal(migrated.changed, true);
  assert.notEqual(migrated.sha, v1.sha);
  const again = await commitTree('sales', generateAgentFiles(SNAPSHOT, { module: hostModuleInputs() }), { reposDir, author, message: 'agents: regenerate' });
  assert.equal(again.changed, false, 'an unchanged system regenerates byte-identical files: no commit');

  const at = await readCommittedModule('sales', 'agents/revenue-review', migrated.sha, { reposDir });
  const expected = generateAgentModule({ id: 'sys_bbb222', slug: 'revenue-review', sys: parseSystem(TEAM_YAML), disabledAgents: ['publisher'], ...hostModuleInputs() });
  const loaded = await loadAgentModule({ committed: at.files, expected: expected.files, commit: at.commit, cacheRoot: mkdtempSync(path.join(os.tmpdir(), 'wp53-migrate-cache-')) });
  assert.deepEqual(loaded.module.TEAM.agents.map((a) => a.id), ['lead', 'researcher']);
  assert.equal(loaded.commit, migrated.sha);
});
