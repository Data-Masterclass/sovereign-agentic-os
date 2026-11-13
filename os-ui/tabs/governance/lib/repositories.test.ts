/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        governance
 * FEATURE:    Governance → Repositories — the view logic, including the honest mirror verdict
 * USER STORY: As a maintainer I want proof that a mirror which pushed an OLDER commit is shown as
 *             BEHIND rather than ok, that a failed push carries its real error, and that the
 *             layout table says which kinds are in git and which are not (checklist G10).
 * ARCHITECTURE:
 *   - Pure functions over the `/api/git?action=repos` payload. No fetch, no DOM, no `.tsx`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mirrorState,
  repoViews,
  mirrorBadgeClass,
  repoSummaryLine,
  layoutViews,
  repoCommitViews,
  type RepoRow,
} from '@tabs/governance/lib/repositories';

const base: RepoRow = {
  domain: 'sales',
  head: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90123456',
  commits: 12,
  countTruncated: false,
  lastAuthor: 'Amir Example',
  lastSubject: 'agents(sales): set schedule cron support — via mcp:commit_agent_files',
  lastAt: '2026-11-14T09:00:00.000Z',
  mirror: null,
};

test('a repository with no mirror says so, and never implies one', () => {
  const { state, detail } = mirrorState(base);
  assert.equal(state, 'none');
  assert.match(detail, /lives only on the OS volume/);
  assert.equal(mirrorBadgeClass('none'), '');
});

test('a mirror that pushed the CURRENT head is ok; one that pushed an older commit is BEHIND', () => {
  const ok = mirrorState({
    ...base,
    mirror: { domain: 'sales', url: 'https://git.example/sales.git', lastSha: base.head!, lastPushedAt: '2026-11-14T09:00:05.000Z' },
  });
  assert.equal(ok.state, 'ok');
  assert.match(ok.detail, /9c1f2ab/);
  const behind = mirrorState({
    ...base,
    mirror: { domain: 'sales', url: 'https://git.example/sales.git', lastSha: '3f81d0c1122334455667788990aabbccddeeff00', lastPushedAt: '2026-11-01T06:00:00.000Z' },
  });
  assert.equal(behind.state, 'behind', 'a successful push to an OLD head is not "ok"');
  assert.match(behind.detail, /now at 9c1f2ab/);
  assert.match(behind.detail, /next commit retries/);
  const never = mirrorState({ ...base, mirror: { domain: 'sales', url: 'https://git.example/sales.git' } });
  assert.equal(never.state, 'behind');
  assert.match(never.detail, /nothing has been pushed yet/);
});

test('a failed push carries the REAL error, never a generic failure', () => {
  const failed = mirrorState({
    ...base,
    mirror: {
      domain: 'sales',
      url: 'https://git.example/sales.git',
      lastSha: base.head!,
      lastError: "mirror host 'git.example' is not on the egress allowlist — push refused",
      lastErrorAt: '2026-11-14T09:01:00.000Z',
    },
  });
  assert.equal(failed.state, 'failed');
  assert.match(failed.detail, /egress allowlist/);
  assert.equal(mirrorBadgeClass('failed'), 'err');
});

test('the rows carry the short head, the commit count, the last author and the clone command', () => {
  const [row] = repoViews([base], 'os-ui.test.svc');
  assert.equal(row.head, '9c1f2ab');
  assert.equal(row.commits, '12');
  assert.equal(row.lastAuthor, 'Amir Example');
  assert.equal(row.cloneHint, 'git clone git://os-ui.test.svc/sales.git');
  const [capped] = repoViews([{ ...base, commits: 2000, countTruncated: true }]);
  assert.equal(capped.commits, '2000+', 'a capped count must not be shown as exact');
  const [fresh] = repoViews([{ ...base, head: null, commits: 0, lastAuthor: null, lastSubject: null, lastAt: null }]);
  assert.equal(fresh.head, '—');
  assert.equal(fresh.commits, '0');
});

test('the roll-up counts failures, and an empty platform says WHY there is nothing', () => {
  assert.match(repoSummaryLine([]), /No domain repository exists yet/);
  assert.equal(repoSummaryLine([base]), '1 repository · 12 commits');
  const line = repoSummaryLine([
    base,
    {
      ...base,
      domain: 'finance',
      mirror: { domain: 'finance', url: 'https://git.example/finance.git', lastError: 'auth failed', lastErrorAt: '2026-11-14T09:00:00.000Z' },
    },
  ]);
  assert.match(line, /2 repositories · 24 commits · 1 mirror push FAILING/);
});

test('the layout table says which kinds are in git, which are landing and which are not', () => {
  const views = layoutViews([
    { kind: 'dataset', label: 'dbt model', paths: ['models/'], personalLane: 'models/personal/<uid>/', writer: { state: 'committed', via: 'tabs/data/lib/dbt/commit.ts', since: 'B1' } },
    { kind: 'dashboard', label: 'dashboard-as-code', paths: ['dashboards/'], personalLane: null, writer: { state: 'landing', via: 'tabs/dashboards/lib/git/commit.ts', stream: 'D' } },
    { kind: 'connection-config', label: 'connection configuration', paths: ['connections/<slug>.yml'], personalLane: null, writer: { state: 'backlog', reason: 'no git writer yet' } },
  ]);
  assert.deepEqual(views.map((v) => [v.kind, v.status]), [
    ['dataset', 'in git'],
    ['dashboard', 'landing'],
    ['connection-config', 'not in git yet'],
  ]);
  assert.equal(views[0].detail, 'tabs/data/lib/dbt/commit.ts (since B1)');
  assert.match(views[1].detail, /lands with D/);
  assert.equal(views[2].detail, 'no git writer yet');
  assert.equal(views[1].personalLane, '—');
});

test('the commit log rows name the action, the object and the surface, and flag an OS catch-up', () => {
  const views = repoCommitViews([
    {
      sha: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90123456',
      subject: 'agents(sales): set schedule cron support — via mcp:commit_agent_files',
      author: 'Amir Example',
      at: '2026-11-14T09:00:00.000Z',
      action: 'set schedule cron',
      surface: 'mcp:commit_agent_files',
      object: 'sys_1 (Support)',
    },
    {
      sha: '3f81d0c1122334455667788990aabbccddeeff00',
      subject: 'agents(sales): reconcile agent systems sales — via boot:reconcile',
      author: 'Sovereign OS',
      at: '2026-11-01T06:00:00.000Z',
      reason: 'boot-reconcile',
    },
  ]);
  assert.deepEqual(
    views.map((v) => [v.short, v.action, v.object, v.surface, v.platform]),
    [
      ['9c1f2ab', 'set schedule cron', 'sys_1 (Support)', 'mcp:commit_agent_files', false],
      ['3f81d0c', 'agents(sales): reconcile agent systems sales — via boot:reconcile', '—', '—', true],
    ],
  );
});
