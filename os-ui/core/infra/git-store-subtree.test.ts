/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Subtree ownership in the git store (Part D) — two generators, one repo
 * USER STORY: As a maintainer I want proof that the Agents generator can rewrite `agents/**` of a
 *             domain repo without touching the dbt project, that the dbt generator (a whole-tree
 *             writer) cannot delete `agents/**` once that subtree is reserved, and that an empty
 *             subtree commit is how a deletion is recorded.
 * ARCHITECTURE:
 *   - Real isomorphic-git against a mkdtemp directory; no network. The reservation registry is
 *     global, so every test clears it (`__clearReservedSubtrees`) and declares what it needs.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitTree,
  commitSubtree,
  listTree,
  readBlob,
  log,
  reserveSubtree,
  reservedSubtrees,
  __clearReservedSubtrees,
  GitStoreError,
} from '@core/infra/git-store';

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-subtree-'));
});
after(() => {
  __clearReservedSubtrees();
  rmSync(reposDir, { recursive: true, force: true });
});
beforeEach(() => __clearReservedSubtrees());

const alex = { name: 'Alexander Borek', email: 'alex@datamasterclass.com' };
const opts = (message: string) => ({ author: alex, message, reposDir });

const paths = async (domain: string): Promise<string[]> => (await listTree(domain, 'main', { reposDir })).map((e) => e.path);

test('reserveSubtree normalises and de-duplicates the prefix', () => {
  reserveSubtree('agents');
  reserveSubtree('agents/');
  reserveSubtree('/agents');
  assert.deepEqual(reservedSubtrees(), ['agents/']);
  assert.throws(() => reserveSubtree(''), GitStoreError);
  assert.throws(() => reserveSubtree('../escape'), GitStoreError);
});

test('commitSubtree replaces only its prefix and keeps the rest of the tree', async () => {
  const d = 'subtree-a';
  await commitTree(d, new Map([['dbt_project.yml', 'name: a\n'], ['models/gold/m.sql', 'select 1\n']]), opts('data(a): generate'));
  const r = await commitSubtree(
    d,
    'agents/',
    new Map([['agents/index.yml', 'systems: []\n'], ['agents/triage/system.yaml', "version: '1'\n"]]),
    opts('agents(a): create triage'),
  );
  assert.equal(r.changed, true);
  assert.deepEqual(await paths(d), ['agents/index.yml', 'agents/triage/system.yaml', 'dbt_project.yml', 'models/gold/m.sql']);
  assert.equal(await readBlob(d, 'main', 'models/gold/m.sql', { reposDir }), 'select 1\n');
  // An unchanged subtree commits nothing.
  const again = await commitSubtree(d, 'agents/', new Map([['agents/index.yml', 'systems: []\n'], ['agents/triage/system.yaml', "version: '1'\n"]]), opts('agents(a): no-op'));
  assert.deepEqual({ changed: again.changed, sha: again.sha }, { changed: false, sha: r.sha });
});

test('an EMPTY subtree commit deletes the subtree and nothing else', async () => {
  const d = 'subtree-b';
  await commitTree(d, new Map([['dbt_project.yml', 'name: b\n']]), opts('data(b): generate'));
  await commitSubtree(d, 'agents/', new Map([['agents/x/system.yaml', 'a\n']]), opts('agents(b): create x'));
  const del = await commitSubtree(d, 'agents/', new Map(), opts('agents(b): delete x'));
  assert.equal(del.changed, true);
  assert.deepEqual(await paths(d), ['dbt_project.yml']);
  assert.equal((await log(d, { reposDir }))[0].subject, 'agents(b): delete x');
});

test('a whole-tree commit PRESERVES a reserved subtree it does not mention', async () => {
  const d = 'subtree-c';
  reserveSubtree('agents/');
  await commitSubtree(d, 'agents/', new Map([['agents/triage/system.yaml', "version: '1'\n"]]), opts('agents(c): create triage'));
  const r = await commitTree(d, new Map([['dbt_project.yml', 'name: c\n']]), opts('data(c): generate'));
  assert.equal(r.changed, true);
  assert.deepEqual(await paths(d), ['agents/triage/system.yaml', 'dbt_project.yml']);
});

test('without a reservation a whole-tree commit still owns the whole tree', async () => {
  const d = 'subtree-d';
  await commitSubtree(d, 'agents/', new Map([['agents/triage/system.yaml', "version: '1'\n"]]), opts('agents(d): create triage'));
  await commitTree(d, new Map([['dbt_project.yml', 'name: d\n']]), opts('data(d): generate'));
  assert.deepEqual(await paths(d), ['dbt_project.yml'], 'the reservation is what protects a subtree — nothing is implicit');
});

test('a path outside the subtree is refused before anything is written', async () => {
  const d = 'subtree-e';
  await assert.rejects(
    () => commitSubtree(d, 'agents/', new Map([['dbt_project.yml', 'name: e\n']]), opts('agents(e): bad')),
    (e: unknown) => e instanceof GitStoreError && /outside the subtree/.test((e as Error).message),
  );
});
