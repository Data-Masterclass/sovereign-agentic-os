/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The boot reconcile, against a REAL bare repo — X-R1 attribution and X-R2 blast radius
 * USER STORY: As an AI engineer I want (X-R1) the system I built before git was switched on to
 *             report the commit it is at instead of "never committed", and (X-R2) one empty draft
 *             in my domain not to stop every other system in that domain from being committed.
 * ARCHITECTURE:
 *   - The same harness `repo.test.ts` uses: isomorphic-git against `mkdtemp`, the real store, the
 *     real generator, the real log, the mirror off. Nothing is faked but the repos directory.
 *   - X-R1 is measured through the READ-BACK (`systemGitInfo`), not by asserting a trailer shape:
 *     the defect was `head: null` in the UI and in `get_agent_system`, so that is what is checked.
 *     The trailer is asserted too, because the complementary path-based fallback is stream G's and
 *     a reviewer needs to see which half this file proves.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '@tabs/agents/lib/store';
import type { Principal } from '@tabs/agents/lib/store';
import { __resetSystemListeners } from '@tabs/agents/lib/system-events';
import { listTree, log, __clearReservedSubtrees } from '@core/infra/git-store';
import { installAgentProjectCommitHook, awaitAgentProjectCommits, __setAgentProjectGitForTests } from '@tabs/agents/lib/git/commit';
import { reconcileAgentProjects, RECONCILE_REASON } from '@tabs/agents/lib/git/reconcile';
import { systemGitInfo } from '@tabs/agents/lib/git/history';

let reposDir = '';
let uninstall: (() => void) | null = null;
const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };

/** A system that PARSES but does not COMPILE: `agents: []`, which `compile` refuses. */
const EMPTY_YAML = `version: '1'
system:
  name: Not populated yet
  domain: sales
  visibility: Personal
entrypoint: ''
state:
  channels:
    messages: add_messages
grants:
  data: []
  knowledge: []
  metrics: []
  tools: []
  connections: []
agents: []
`;

before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-reconcile-'));
});
after(() => {
  rmSync(reposDir, { recursive: true, force: true });
  __clearReservedSubtrees();
});
beforeEach(() => {
  store.__resetStore();
  __resetSystemListeners();
  __clearReservedSubtrees();
  __setAgentProjectGitForTests(true);
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  __setAgentProjectGitForTests(null);
});

/** Create systems with git OFF — what every system that predates the flag looks like. */
function createdBeforeGit(make: () => void): void {
  __setAgentProjectGitForTests(false);
  uninstall = installAgentProjectCommitHook({ reposDir, mirror: false });
  make();
  __setAgentProjectGitForTests(true);
}

test('X-R1: a system that predates git reports the reconcile commit as its head, not null', async () => {
  let id = '';
  createdBeforeGit(() => {
    id = store.createSystem(amir, { name: 'Built before git' }).id;
  });
  await awaitAgentProjectCommits();
  assert.deepEqual(await log('sales', { reposDir }), [], 'nothing was committed while the flag was off');

  // BEFORE the fix the reconcile commit carried `OS-Object: sales` only, so this read-back — the
  // one the tab header and `get_agent_system` render — answered `head: null`, i.e. "this system
  // has never been committed", about a system sitting in the repository.
  const outcomes = await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });
  assert.deepEqual(outcomes.map((o) => [o.domain, o.changed]), [['sales', true]]);

  const info = await systemGitInfo('sales', id, { reposDir });
  assert.ok(info, 'the read-back answers for a domain that has a repo');
  assert.ok(info.head, 'X-R1: the pre-existing system resolves a HEAD commit');
  assert.equal(info.head.reason, RECONCILE_REASON, 'and it is the boot reconcile commit');
  assert.equal(info.head.surface, 'boot:reconcile');
  assert.equal(info.head.sha, outcomes[0].sha, 'the sha is the one the reconcile produced');
  assert.deepEqual(info.history.map((c) => c.sha), [outcomes[0].sha], 'it is in the history too');

  // The mechanism: the whole-subtree commit lists every system it carried.
  const [entry] = await log('sales', { reposDir });
  assert.equal(entry.trailers['OS-Object'], 'sales', 'the single-valued trailer still names the subtree');
  assert.deepEqual((entry.trailers['OS-Objects'] ?? '').split(' '), [id], 'OS-Objects names the system');
});

test('X-R1: OS-Objects matching is whole-token — a different id with the same prefix does not match', async () => {
  let kept = '';
  createdBeforeGit(() => {
    kept = store.createSystem(amir, { name: 'Only one here' }).id;
  });
  await awaitAgentProjectCommits();
  await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });

  assert.ok((await systemGitInfo('sales', kept, { reposDir }))?.head, 'the real id matches');
  const prefix = kept.slice(0, kept.length - 1);
  assert.equal((await systemGitInfo('sales', prefix, { reposDir }))?.head, null, 'a PREFIX of it does not');
  assert.equal((await systemGitInfo('sales', `${kept}x`, { reposDir }))?.head, null, 'nor does an extension of it');
});

test('X-R1: every system in a multi-system domain resolves its head from one reconcile commit', async () => {
  const ids: string[] = [];
  createdBeforeGit(() => {
    ids.push(store.createSystem(amir, { name: 'First' }).id);
    ids.push(store.createSystem(amir, { name: 'Second' }).id);
    ids.push(store.createSystem(amir, { name: 'Third' }).id);
  });
  await awaitAgentProjectCommits();
  const [outcome] = await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });

  for (const id of ids) {
    const info = await systemGitInfo('sales', id, { reposDir });
    assert.equal(info?.head?.sha, outcome.sha, `${id} resolves the reconcile commit`);
  }
  const [entry] = await log('sales', { reposDir });
  assert.deepEqual((entry.trailers['OS-Objects'] ?? '').split(' ').sort(), [...ids].sort(), 'all three are attributed');
});

test('X-R2: one zero-agent system does not stop its domain being reconciled', async () => {
  let empty = '';
  let healthy = '';
  createdBeforeGit(() => {
    empty = store.createSystem(amir, { name: 'Not populated yet', yaml: EMPTY_YAML }).id;
    healthy = store.createSystem(amir, { name: 'Support triage' }).id;
  });
  await awaitAgentProjectCommits();

  // BEFORE the fix `compile` threw out of the WHOLE-SUBTREE generator, so this outcome was
  // `{ changed: false, error: 'system.yaml: at least one agent is required' }` and NOTHING in the
  // domain — not one healthy system — was committed.
  const outcomes = await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].error, undefined, 'X-R2: the domain no longer fails on one empty draft');
  assert.equal(outcomes[0].changed, true, 'and it commits');

  const paths = (await listTree('sales', 'main', { reposDir })).map((p) => p.path).filter((p) => p.startsWith('agents/'));
  assert.ok(paths.some((p) => p.endsWith('/not-populated-yet/system.yaml')), "the empty system's source is committed");
  assert.equal(paths.some((p) => p.endsWith('/not-populated-yet/graph.json')), false, 'with no compiled graph');
  assert.ok(paths.some((p) => p.endsWith('/support-triage/graph.json')), 'and the healthy system is complete');

  // Both are still attributed, so both resolve a head (X-R1 and X-R2 together).
  for (const id of [empty, healthy]) {
    assert.ok((await systemGitInfo('sales', id, { reposDir }))?.head, `${id} resolves a head`);
  }
});
