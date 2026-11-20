/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Personal agent systems in the user repo, and My → Domain promotion as a git merge
 * USER STORY: As a creator I want my personal systems in MY repository and not in the domain's;
 *             as a domain admin I want an approved promotion to arrive in the domain repo as a merge
 *             that names me and the approval, carrying that system's history — and nothing else of
 *             the owner's personal repository (component design 12).
 * ARCHITECTURE:
 *   - The real commit path (`commitAgentSystem`) over a temp `reposDir`, with the snapshot and the
 *     cross-domain system list injected; every assertion is read back with the real `git` CLI.
 *   - A v1 domain repo is the negative twin: there the personal lane stays where it was.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureV2Repo, commitTree, repoPath } from '@core/infra/git-store';
import { commitAgentSystem, __setAgentProjectGitForTests } from '@tabs/agents/lib/git/commit';
import type { SnapshotSystem } from '@tabs/agents/lib/git/snapshot';
import { userRepoName, legacyPersonalAgentLane } from '@core/infra/repo-layout';
import { rerootPersonal } from '@tabs/agents/lib/git/personal-repo';

let reposDir = '';
const ALICE = { id: 'alice@example.com', name: 'Alice', email: 'alice@example.com' };
const BOB = { id: 'bob@example.com', name: 'Bob', email: 'bob@example.com' };
const YAML = (v: number) => `name: Triage\nversion: ${v}\nagents:\n  - id: lead\n    role: supervisor\n`;

function sys(over: Partial<SnapshotSystem> & Pick<SnapshotSystem, 'id' | 'name' | 'owner' | 'visibility' | 'yaml'>): SnapshotSystem {
  return { origin: 'authored', running: false, schedule: { kind: 'manual' }, disabledAgents: [], folder: '/', version: 1, ...over } as SnapshotSystem;
}

function gitc(gitdir: string, args: string[]): string {
  return execFileSync('git', ['--git-dir', gitdir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } });
}

before(() => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp55-agents-'));
  __setAgentProjectGitForTests(true);
});

test('v2: a personal system is committed to its owner\'s user repo, never the domain repo; promotion merges it in', async () => {
  await ensureV2Repo('sales', { reposDir });
  const mine = sys({ id: 'sys_triage1', name: 'Triage', owner: ALICE.id, visibility: 'Personal', yaml: YAML(1) });
  const secret = sys({ id: 'sys_secret1', name: 'Secret plan', owner: ALICE.id, visibility: 'Personal', yaml: 'name: Secret plan\n' });
  const deps = (systems: SnapshotSystem[]) => ({ reposDir, mirror: false, captured: systems, allSystems: () => systems });

  await commitAgentSystem('sales', ALICE, { action: 'create system', object: 'triage' }, deps([mine, secret]));
  const v2 = { ...mine, yaml: YAML(2), version: 2 };
  await commitAgentSystem('sales', ALICE, { action: 'edit system.yaml', object: 'triage' }, deps([v2, secret]));

  const user = repoPath(userRepoName(ALICE.id), { reposDir });
  const dom = repoPath('sales', { reposDir });
  assert.match(gitc(user, ['ls-tree', '-r', '--name-only', 'main']), /^agents\/triage\/system\.yaml$/m);
  assert.doesNotMatch(gitc(dom, ['ls-tree', '-r', '--name-only', 'main']), /triage|secret|personal/, 'nothing personal in the domain repo');
  assert.doesNotMatch(gitc(dom, ['show', 'main:agents/index.yml']), /sys_triage1|sys_secret1/, 'not even in the index');

  // The approved promotion: Personal → Shared, approved by Bob as apr_42.
  const shared = { ...v2, visibility: 'Shared' as const };
  const r = await commitAgentSystem(
    'sales',
    BOB,
    { action: 'promote to Shared', object: 'triage', promotion: { approvalId: 'apr_42', approverId: BOB.id, approverName: 'Bob', systemId: mine.id } },
    deps([shared, secret]),
  );
  assert.ok(r?.changed);
  const parents = gitc(dom, ['log', '-1', '--format=%P', 'main']).trim().split(' ');
  assert.equal(parents.length, 2, 'the promotion is a MERGE commit');
  const body = gitc(dom, ['log', '-1', '--format=%B', 'main']);
  assert.match(body, /^OS-Approval: apr_42$/m);
  assert.match(body, /^OS-Approved-By: Bob <bob@example\.com>$/m);
  assert.match(body, /^OS-Reason: promotion-merge$/m);
  // The system's own history came with it, at its DOMAIN path.
  const hist = gitc(dom, ['log', '--format=%s', 'main', '--', 'agents/triage/system.yaml']);
  assert.match(hist, /edit system\.yaml/);
  assert.match(hist, /create system/);
  assert.equal(gitc(dom, ['show', 'main:agents/triage/system.yaml']), YAML(2));
  // ...and NOTHING else of the user repo: no object of the other personal system is reachable.
  const everything = gitc(dom, ['log', '--all', '--name-only', '--format=']);
  assert.doesNotMatch(everything, /secret/i, 'the merge carries only the promoted folder');
  // The user repo no longer holds it; the other personal system stays there.
  const userTree = gitc(user, ['ls-tree', '-r', '--name-only', 'main']);
  assert.doesNotMatch(userTree, /agents\/triage\//);
  assert.match(userTree, /agents\/secret-plan\/system\.yaml/);
});

test('v1 (not migrated): the personal lane stays in the domain repo, no user repo is created (negative twin)', async () => {
  await commitTree('legacy', new Map([['dbt_project.yml', 'name: legacy\n']]), { author: ALICE, message: 'seed', reposDir });
  const bobSys = sys({ id: 'sys_bob1', name: 'Bob bot', owner: BOB.id, visibility: 'Personal', yaml: 'name: Bob bot\n' });
  await commitAgentSystem('legacy', BOB, { action: 'create system' }, { reposDir, mirror: false, captured: [bobSys], allSystems: () => [bobSys] });
  const tree = gitc(repoPath('legacy', { reposDir }), ['ls-tree', '-r', '--name-only', 'main']);
  assert.ok(tree.includes(`${legacyPersonalAgentLane(BOB.id)}bob-bot/system.yaml`), tree);
  assert.ok(!fs.existsSync(path.join(reposDir, `${userRepoName(BOB.id)}.git`)));
});

test('rerootPersonal maps the legacy lane to agents/ in paths AND generated text', () => {
  const lane = legacyPersonalAgentLane('amir');
  const out = rerootPersonal(new Map([[`${lane}x/README.md`, `see ${lane}x/system.yaml`]]), 'amir');
  assert.deepEqual([...out.entries()], [['agents/x/README.md', 'see agents/x/system.yaml']]);
});
