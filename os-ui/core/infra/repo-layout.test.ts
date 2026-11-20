/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Repo layout tests — repository names, the read boundary and the v1 → v2 path maps
 * USER STORY: As a maintainer I want proof that every repo kind round-trips through its name, that
 *             read access follows the repo boundary (a user repo only for its owner and admins),
 *             and that the dbt paths map both ways for a v1 and a v2 repository.
 * ARCHITECTURE:
 *   - Pure functions only; the git-server path itself is proven in git-layout-http.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  domainRepoName, userRepoName, legacyDomainRepoName, parseRepoName, repoName, repoDirName, mayReadRepo,
  principalToken, PLATFORM_REPO, layoutOf, LAYOUT_MARKER_PATH, LAYOUT_V1, LAYOUT_V2, dbtProjectDir, dbtRepoPath,
  dbtProjectPath, layoutMigrationMoves, configuredDbtProjectDir, DEFAULT_DBT_PROJECT_DIR, agentGraphPath,
  DAGSTER_DEFINITIONS_PATH, dashboardDir, connectionCatalogPath, osPath, legacyPersonalAgentLane, layoutMarker,
} from '@core/infra/repo-layout';

test('repo names: each kind round-trips through parseRepoName', () => {
  assert.equal(domainRepoName('kiekert'), 'domain-kiekert');
  assert.deepEqual(parseRepoName('domain-kiekert'), { kind: 'domain', domain: 'kiekert', legacy: false });
  assert.deepEqual(parseRepoName('kiekert'), { kind: 'domain', domain: 'kiekert', legacy: true });
  const u = userRepoName('alice@example.com');
  assert.match(u, /^user-[0-9a-f]{12}$/);
  assert.ok(!u.includes('alice'), 'a user repo name never carries the principal id');
  assert.deepEqual(parseRepoName(u), { kind: 'user', token: principalToken('alice@example.com') });
  assert.deepEqual(parseRepoName(PLATFORM_REPO), { kind: 'platform' });
  assert.equal(repoName({ kind: 'platform' }), 'platform');
  assert.equal(repoDirName('domain-kiekert'), 'domain-kiekert.git');
});

test('repo names: unsafe or reserved names are refused, never aliased', () => {
  assert.equal(parseRepoName('../etc'), null);
  assert.equal(parseRepoName('user-notahexx'), null);
  assert.throws(() => domainRepoName('a/b'));
  assert.equal(legacyDomainRepoName('platform'), null);
  assert.equal(legacyDomainRepoName('user-x'), null);
  assert.equal(legacyDomainRepoName('kiekert'), 'kiekert');
});

test('read boundary: user repo = owner + admin; domain = members; platform = admin', () => {
  const a = { id: 'alice@example.com', role: 'creator', domains: ['kiekert'] };
  const b = { id: 'bob@example.com', role: 'domain_admin', domains: ['kiekert'] };
  const admin = { id: 'root', role: 'admin', domains: [] };
  assert.equal(mayReadRepo(userRepoName(a.id), a), true);
  assert.equal(mayReadRepo(userRepoName(a.id), b), false, 'a domain member (even its admin) cannot read another user repo');
  assert.equal(mayReadRepo(userRepoName(a.id), admin), true);
  assert.equal(mayReadRepo('domain-kiekert', a), true);
  assert.equal(mayReadRepo('kiekert', a), true, 'the legacy alias reads like the domain repo');
  assert.equal(mayReadRepo('domain-europace', a), false);
  assert.equal(mayReadRepo(PLATFORM_REPO, b), false);
  assert.equal(mayReadRepo(PLATFORM_REPO, admin), true);
  assert.equal(mayReadRepo('../x', admin), false);
});

test('layout: v1 has the dbt project at the root, v2 under the configured dir', () => {
  assert.equal(configuredDbtProjectDir(), DEFAULT_DBT_PROJECT_DIR);
  assert.equal(layoutOf(['dbt_project.yml', 'models/a.sql']), LAYOUT_V1);
  assert.equal(layoutOf(['data/dbt/dbt_project.yml', LAYOUT_MARKER_PATH]), LAYOUT_V2);
  assert.equal(dbtProjectDir(LAYOUT_V1), '');
  assert.equal(dbtProjectDir(LAYOUT_V2), 'data/dbt');
  assert.equal(dbtRepoPath('models/gold/x.sql', LAYOUT_V1), 'models/gold/x.sql');
  assert.equal(dbtRepoPath('models/gold/x.sql', LAYOUT_V2), 'data/dbt/models/gold/x.sql');
  assert.equal(dbtRepoPath('os/schedules.yml', LAYOUT_V2), 'os/schedules.yml', 'the OS layer never moves');
  assert.equal(dbtProjectPath('data/dbt/models/gold/x.sql', LAYOUT_V2), 'models/gold/x.sql');
  assert.equal(dbtProjectPath('agents/a/README.md', LAYOUT_V2), null);
  assert.ok(layoutMarker().includes('version: 2'));
});

test('layout: the configured dbt dir is ONE env value and is validated', () => {
  const prev = process.env.OS_DBT_PROJECT_DIR;
  try {
    process.env.OS_DBT_PROJECT_DIR = 'data/transform';
    assert.equal(configuredDbtProjectDir(), 'data/transform');
    process.env.OS_DBT_PROJECT_DIR = '../escape';
    assert.throws(() => configuredDbtProjectDir());
  } finally {
    if (prev === undefined) delete process.env.OS_DBT_PROJECT_DIR;
    else process.env.OS_DBT_PROJECT_DIR = prev;
  }
});

test('migration moves: dbt files move under data/dbt, the rest keep their place', () => {
  const moves = layoutMigrationMoves([
    'dbt_project.yml', 'profiles.yml', 'README.md', '.gitignore', 'models/gold/g.sql', 'macros/m.sql',
    'agents/index.yml', 'dashboards/d/x.vl.json', 'os/lifecycle/pins.yml',
  ]);
  assert.deepEqual(moves, [
    { from: '.gitignore', to: 'data/dbt/.gitignore' },
    { from: 'README.md', to: 'data/dbt/README.md' },
    { from: 'dbt_project.yml', to: 'data/dbt/dbt_project.yml' },
    { from: 'macros/m.sql', to: 'data/dbt/macros/m.sql' },
    { from: 'models/gold/g.sql', to: 'data/dbt/models/gold/g.sql' },
    { from: 'profiles.yml', to: 'data/dbt/profiles.yml' },
  ]);
});

test('object paths come from here (the documented targets of WP-49, WP-52, WP-53, WP-50)', () => {
  assert.equal(agentGraphPath('support-triage'), 'agents/support-triage/graph.mjs');
  assert.equal(DAGSTER_DEFINITIONS_PATH, 'data/dagster/definitions.py');
  assert.equal(dashboardDir('sales'), 'dashboards/sales');
  assert.equal(connectionCatalogPath('pg'), 'connections/pg/catalog.properties');
  assert.equal(osPath('lifecycle', 'pins.yml'), 'os/lifecycle/pins.yml');
  assert.equal(legacyPersonalAgentLane('alice'), `agents/personal/${principalToken('alice')}/`);
  assert.throws(() => agentGraphPath('../x'));
});
