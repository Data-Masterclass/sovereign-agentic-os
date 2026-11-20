/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The receive gate under the v2 layout and for user repositories
 * USER STORY: As a maintainer I want the push rules to hold wherever the dbt project lives
 *             (`data/dbt/` after the migration) and in a personal repository: OS-owned files stay
 *             OS-owned, a creator's own lane stays theirs, and only the owner may push their repo.
 * ARCHITECTURE:
 *   - Pure decisions (`decidePath`, `filesForKind`, `mayPushRepo`); the real-push path is proved in
 *     git-receive-push.test.ts and the read boundary in git-layout-http.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePath, filesForKind, mayPushRepo, personalDataLane, type Pusher, type RepoKind } from '@core/infra/git-receive';
import { LAYOUT_V2, userRepoName } from '@core/infra/repo-layout';

const creator: Pusher = { id: 'amir', role: 'creator', domains: ['sales'] };
const builder: Pusher = { id: 'bea', role: 'builder', domains: ['sales'] };
const v2 = { layout: LAYOUT_V2 } as const;

test('v2: the dbt project\'s OS-owned files are refused at data/dbt/, as they were at the root', () => {
  for (const p of ['data/dbt/dbt_project.yml', 'data/dbt/profiles.yml', 'data/dbt/macros/os_maintenance.sql', 'os/layout.yml', 'agents/index.yml']) {
    assert.equal(decidePath(p, builder, v2).allowed, false, p);
  }
  assert.equal(decidePath('data/dbt/models/gold/gold_x.sql', builder, v2).allowed, true);
  assert.equal(decidePath('data/dbt/models/gold/gold_x.sql', creator, v2).allowed, false, 'a shared path is not a creator\'s');
  assert.equal(decidePath(`data/dbt/${personalDataLane('amir')}silver_x.sql`, creator, v2).allowed, true, 'the creator\'s own lane');
  assert.equal(decidePath(`data/dbt/${personalDataLane('bea')}silver_x.sql`, creator, v2).allowed, false, 'someone else\'s lane');
});

test('a user repo: the owner may push anything not OS-owned; nobody else may push it', () => {
  const repo = userRepoName('amir');
  assert.equal(mayPushRepo(repo, creator), true);
  assert.equal(mayPushRepo(repo, builder), false);
  assert.equal(mayPushRepo(repo, { ...builder, role: 'admin' }), false, 'not even an admin writes someone\'s personal repo');
  assert.equal(decidePath('agents/triage/system.yaml', creator, { layout: LAYOUT_V2, repoKind: 'user' }).allowed, true);
  assert.equal(decidePath('os/layout.yml', creator, { layout: LAYOUT_V2, repoKind: 'user' }).allowed, false);
  assert.equal(mayPushRepo('sales', creator), true);
  assert.equal(mayPushRepo('domain-sales', creator), true);
  assert.equal(mayPushRepo('domain-finance', creator), false);
  assert.equal(mayPushRepo('platform', builder), false);
});

test('a dbt-rooted kind sees project paths in v2, repo paths otherwise', () => {
  const dbt: RepoKind = { kind: 'd', root: 'dbt', matches: (p) => p.startsWith('models/'), validate: () => null, ingest: async () => ({ kind: 'd', created: 0, updated: 0, skipped: 0, notes: [] }) };
  const other: RepoKind = { ...dbt, root: undefined, matches: (p) => p.startsWith('agents/') };
  const files = [
    { path: 'data/dbt/models/gold/x.sql', status: 'added' as const, content: 'select 1' },
    { path: 'agents/a/system.yaml', status: 'added' as const, content: 'x' },
    { path: 'models/stray.sql', status: 'added' as const, content: 'select 2' },
  ];
  assert.deepEqual(filesForKind(dbt, files, LAYOUT_V2).map((f) => f.path), ['models/gold/x.sql']);
  assert.deepEqual(filesForKind(other, files, LAYOUT_V2).map((f) => f.path), ['agents/a/system.yaml']);
  assert.deepEqual(filesForKind(dbt, files, 1).map((f) => f.path), ['models/stray.sql']);
});
