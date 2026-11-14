/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    End-to-end: the real store → the real repo → the boot reconcile → the read-back
 * USER STORY: As a maintainer I want proof against a REAL bare repository (temp dir, no cluster)
 *             that two saves are two commits authored as the acting user, that the agents subtree
 *             and the dbt project coexist in one repo, that the boot reconcile commits the delta
 *             as the platform principal with `OS-Reason: boot-reconcile`, and that the read-back
 *             reports the commit a system is at — from the repo, not from a parallel ledger.
 * ARCHITECTURE:
 *   - isomorphic-git against `mkdtemp`; the real commit hook, the real generator, the real log.
 *   - The mirror push is switched off (`mirror: false`) — it needs a remote (checklist X2).
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '@tabs/agents/lib/store';
import type { Principal } from '@tabs/agents/lib/store';
import { __resetSystemListeners } from '@tabs/agents/lib/system-events';
import { runWithSurface } from '@core/infra/request-surface';
import { commitTree, listTree, readBlob, log, __clearReservedSubtrees, COMMITTER } from '@core/infra/git-store';
import {
  installAgentProjectCommitHook,
  awaitAgentProjectCommits,
  __setAgentProjectGitForTests,
} from '@tabs/agents/lib/git/commit';
import { reconcileAgentProjects, PLATFORM_ACTOR, RECONCILE_REASON } from '@tabs/agents/lib/git/reconcile';
import { ownerToken } from '@tabs/agents/lib/git/generate';
import { systemGitInfo } from '@tabs/agents/lib/git/history';

let reposDir = '';
let uninstall: (() => void) | null = null;
const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
/** A personal lane is keyed by the OPAQUE owner token, never the principal id (review M-1). */
const AMIR_LANE = `agents/personal/${ownerToken('amir')}`;

before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-agents-'));
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

function install(): void {
  uninstall = installAgentProjectCommitHook({
    reposDir,
    mirror: false,
    resolveActor: async (id) => ({ id, name: 'Amir Example', email: 'amir@example.com' }),
  });
}

test('two saves are two commits, authored as the acting user and committed by Sovereign OS', async () => {
  install();
  const id = await runWithSurface('ui:agents/systems', async () => store.createSystem(amir, { name: 'Triage one' }).id);
  await awaitAgentProjectCommits();
  await runWithSurface('ui:agents/systems/[id]', async () => store.renameAgentSystem(id, amir, 'Triage two'));
  await awaitAgentProjectCommits();

  const entries = await log('sales', { reposDir });
  assert.equal(entries.length, 2, 'one commit per save');
  // The slug follows the DISPLAY name, so a rename moves the directory — the id in `index.yml`
  // and the `OS-Object` trailer are what stay frozen.
  assert.match(entries[0].subject, /^agents\(sales\): rename system triage-two — via ui:agents\/systems\/\[id\]$/);
  assert.match(entries[1].subject, /^agents\(sales\): create system triage-one — via ui:agents\/systems$/);
  for (const e of entries) {
    assert.deepEqual(e.author, { name: 'Amir Example', email: 'amir@example.com' });
    assert.deepEqual(e.committer, { name: COMMITTER.name, email: COMMITTER.email });
    assert.equal(e.trailers['OS-Actor'], 'amir');
  }
  const paths = (await listTree('sales', 'main', { reposDir })).map((p) => p.path);
  assert.deepEqual(paths, [
    'agents/index.yml',
    `${AMIR_LANE}/triage-two/README.md`,
    `${AMIR_LANE}/triage-two/agents/assistant.md`,
    `${AMIR_LANE}/triage-two/graph.json`,
    `${AMIR_LANE}/triage-two/system.yaml`,
  ]);
  // The yaml's `system.name` is deliberately frozen by `renameAgentSystem` (the record's display
  // name is what changed), so the committed source still reads the original — and says so.
  assert.match(await readBlob('sales', 'main', `${AMIR_LANE}/triage-two/system.yaml`, { reposDir }), /name: Triage one/);
  assert.match(await readBlob('sales', 'main', `${AMIR_LANE}/triage-two/README.md`, { reposDir }), /^# Triage two/);
});

test('an identical regeneration commits nothing', async () => {
  install();
  const id = store.createSystem(amir, { name: 'Idem' }).id;
  await awaitAgentProjectCommits();
  const before = (await log('sales', { reposDir })).length;
  // A no-op rename returns early in the store; a schedule set to the same value still writes the
  // record, so the tree is regenerated and the git store must refuse to commit it.
  store.setSchedule(id, amir, { kind: 'manual' });
  await awaitAgentProjectCommits();
  assert.equal((await log('sales', { reposDir })).length, before, 'an unchanged subtree is not a commit');
});

test('the agents subtree and the dbt project coexist: neither generator deletes the other', async () => {
  install(); // reserves `agents/`
  store.createSystem(amir, { name: 'Coexist' });
  await awaitAgentProjectCommits();
  // The data side writes the WHOLE tree, exactly as `commitDataProject` does.
  await commitTree(
    'sales',
    new Map([['dbt_project.yml', 'name: sales\n'], ['models/gold/mart.sql', 'select 1\n']]),
    { author: { name: 'Amir Example', email: 'amir@example.com' }, message: 'data(sales): generate', reposDir },
  );
  const paths = (await listTree('sales', 'main', { reposDir })).map((p) => p.path);
  assert.ok(paths.includes('dbt_project.yml') && paths.includes('models/gold/mart.sql'));
  assert.ok(paths.some((p) => p.startsWith(`${AMIR_LANE}/coexist/`)), 'the dbt commit kept the agents subtree');
  // …and the next agent change keeps the dbt project.
  store.renameAgentSystem(store.listSystems(amir).mine[0].id, amir, 'Coexist 2');
  await awaitAgentProjectCommits();
  const after = (await listTree('sales', 'main', { reposDir })).map((p) => p.path);
  assert.ok(after.includes('dbt_project.yml') && after.includes('models/gold/mart.sql'), 'the agents commit kept the dbt project');
});

test('the boot reconcile commits what happened while git was off, as the platform principal', async () => {
  // The flag is OFF while the user works: nothing is committed.
  __setAgentProjectGitForTests(false);
  install();
  store.createSystem(amir, { name: 'Offline work' });
  await awaitAgentProjectCommits();
  __setAgentProjectGitForTests(true);
  assert.deepEqual(await log('reconcile-domain', { reposDir }), [], 'nothing was committed with the flag off');

  const first = await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });
  assert.deepEqual(first, [{ domain: 'sales', changed: true, sha: first[0].sha }]);
  const entries = await log('sales', { reposDir });
  assert.match(entries[0].subject, /^agents\(sales\): reconcile agent systems sales — via boot:reconcile$/);
  assert.equal(entries[0].trailers['OS-Reason'], RECONCILE_REASON);
  assert.equal(entries[0].trailers['OS-Actor'], PLATFORM_ACTOR.id);
  assert.deepEqual(entries[0].author, { name: PLATFORM_ACTOR.name, email: PLATFORM_ACTOR.email });
  assert.ok((await listTree('sales', 'main', { reposDir })).some((p) => p.path.startsWith(`${AMIR_LANE}/offline-work/`)));

  // Idempotent: a second reconcile with nothing changed commits nothing.
  const second = await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });
  assert.deepEqual(second, [{ domain: 'sales', changed: false, sha: entries[0].sha }]);
});

test('reconcile commits the REMOVAL of one system among several, and skips a data-only repo', async () => {
  install();
  store.createSystem(amir, { name: 'Stays here' });
  store.createSystem(amir, { name: 'Gone soon' });
  await awaitAgentProjectCommits();
  // A data-only repo: no agent system ever lived here.
  await commitTree('dataonly', new Map([['dbt_project.yml', 'name: dataonly\n']]), {
    author: { name: 'x', email: 'x@os.local' },
    message: 'data(dataonly): generate',
    reposDir,
  });
  // Delete one system WITHOUT the hook, so the repo is now stale (what a crash looks like).
  uninstall?.();
  uninstall = null;
  const doomed = store.listSystems(amir).mine.find((s) => s.name === 'Gone soon')!;
  store.deleteSystem(doomed.id, amir);

  const outcomes = await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });
  assert.deepEqual(
    outcomes.map((o) => [o.domain, o.changed]),
    [['sales', true]],
    'only the domain that HAS an agents subtree (or systems) is reconciled',
  );
  const paths = (await listTree('sales', 'main', { reposDir })).map((p) => p.path).filter((p) => p.startsWith('agents/'));
  assert.equal(paths.some((p) => p.includes('/gone-soon/')), false, 'the removal is committed');
  assert.ok(paths.some((p) => p.includes('/stays-here/')), 'the system that remains is untouched');
  assert.deepEqual((await listTree('dataonly', 'main', { reposDir })).map((p) => p.path), ['dbt_project.yml'], 'the data-only repo grew no agents/ directory');
});

test('a reconcile that would wipe most of the subtree is REFUSED (review H-1 destructive-delta guard)', async () => {
  install();
  store.createSystem(amir, { name: 'Alone here' });
  store.createSystem(amir, { name: 'Also here' });
  await awaitAgentProjectCommits();
  const before = (await listTree('sales', 'main', { reposDir })).map((p) => p.path).filter((p) => p.startsWith('agents/'));
  assert.ok(before.length >= 5);
  // THE OUTAGE SHAPE: the store hydrated EMPTY (or every system vanished at once) while the repo
  // still holds them. `ensureHydrated()` would not have thrown, which is why the git store refuses.
  uninstall?.();
  uninstall = null;
  for (const s of store.listSystems(amir).mine) store.deleteSystem(s.id, amir);

  const outcomes = await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => 'hydrated' });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].changed, false, 'nothing was committed');
  assert.match(outcomes[0].error ?? '', /refusing a boot-reconcile commit/);
  assert.deepEqual(
    (await listTree('sales', 'main', { reposDir })).map((p) => p.path).filter((p) => p.startsWith('agents/')),
    before,
    'the subtree is byte-identical: an automatic catch-up never deletes most of a tree',
  );
});

test('the boot reconcile does NOT run while the registry is unverified (review H-1 hydration gate)', async () => {
  install();
  store.createSystem(amir, { name: 'Must survive' });
  await awaitAgentProjectCommits();
  const before = (await listTree('sales', 'main', { reposDir })).map((p) => p.path);
  uninstall?.();
  uninstall = null;
  // A mirror-down hydration: `ensureHydrated()` RESOLVED, and the registry is empty anyway.
  store.__resetStore();
  for (const hydration of ['failed', 'pending'] as const) {
    assert.deepEqual(await reconcileAgentProjects({ reposDir, mirror: false, hydration: () => hydration }), [], `'${hydration}' reconciles nothing`);
  }
  assert.deepEqual((await listTree('sales', 'main', { reposDir })).map((p) => p.path), before, 'no commit, no deletion');
});

test('read-back: the commit a system is at, its author and time, and its history — from the repo', async () => {
  install();
  const id = await runWithSurface('ui:agents/systems', async () => store.createSystem(amir, { name: 'Readback' }).id);
  await awaitAgentProjectCommits();
  await runWithSurface('mcp:commit_agent_files', async () => store.setSchedule(id, amir, { kind: 'cron', cron: '0 6 * * *' }));
  await awaitAgentProjectCommits();
  // Another system's commits must not leak into this one's history.
  store.createSystem(amir, { name: 'Unrelated' });
  await awaitAgentProjectCommits();

  const info = (await systemGitInfo('sales', id, { reposDir }))!;
  assert.equal(info.truncated, false, 'the whole history fitted in the scan window');
  assert.equal(info.domain, 'sales');
  assert.equal(info.history.length, 2);
  assert.equal(info.head!.sha, info.history[0].sha);
  assert.equal(info.head!.author, 'Amir Example');
  assert.equal(info.head!.action, 'set schedule cron');
  assert.equal(info.head!.surface, 'mcp:commit_agent_files');
  assert.equal(info.head!.actor, 'amir');
  assert.ok(Date.parse(info.head!.at) > 0, 'the time comes from the commit');
  assert.deepEqual(info.history.map((h) => h.action), ['set schedule cron', 'create system']);

  __setAgentProjectGitForTests(false);
  assert.equal(await systemGitInfo('sales', id, { reposDir }), null, 'off ⇒ an honest null, never a fabricated sha');
});

test('a history that does not fit the scan window is flagged, and the HEAD is still found (review L-1)', async () => {
  install();
  const id = await runWithSurface('ui:agents/systems', async () => store.createSystem(amir, { name: 'Busy domain' }).id);
  await awaitAgentProjectCommits();
  // Later, unrelated commits in the SAME repo (the dbt project's half) push the system's own
  // commit out of a 1-commit scan window.
  for (let i = 0; i < 3; i++) {
    await commitTree('sales', new Map([['dbt_project.yml', `name: sales\n# rev ${i}\n`], ['models/gold/mart.sql', 'select 1\n']]), {
      author: { name: 'x', email: 'x@os.local' },
      message: `data(sales): generate rev ${i}`,
      reposDir,
    });
  }
  const narrow = (await systemGitInfo('sales', id, { reposDir, scan: 1, limit: 10 }))!;
  assert.equal(narrow.truncated, true, 'the window ran out — history is not claimed to be complete');
  assert.ok(narrow.head, 'the HEAD is resolved by the deeper bounded walk, never a false null');
  assert.match(narrow.head!.subject, /Busy domain|busy-domain/);
  const wide = (await systemGitInfo('sales', id, { reposDir }))!;
  assert.equal(wide.truncated, false);
  assert.equal(wide.head!.sha, narrow.head!.sha, 'both answers agree about which commit the system is at');
});

test('read-back of a system with no repo yet is an empty history, not an error', async () => {
  // Night 2 (stream G): the reader is now the generic `objectGitInfo`, so the answer also carries
  // WHICH source resolved it (`via`) and WHICH repo paths were looked at — an honest 'none'/[] for
  // a domain with no repository, never a fabricated head.
  assert.deepEqual(await systemGitInfo('never-seen', 'sys_nope', { reposDir }), {
    domain: 'never-seen',
    head: null,
    history: [],
    truncated: false,
    via: 'none',
    paths: [],
  });
});
