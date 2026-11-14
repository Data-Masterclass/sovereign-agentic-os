/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The git badge / drawer logic — every decision the `.tsx` shells render
 * USER STORY: As a maintainer I want the badge's label and empty states, the drawer rows, the
 *             diff classification and the four restore states pinned by tests, because a test
 *             cannot import the components that show them (checklist G6).
 * ARCHITECTURE:
 *   - Pure functions, fixed `now`, no fetch, no DOM. The fixtures mirror what `/api/git`
 *     returns, which mirrors `core/infra/git-objects.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sha7,
  relativeTime,
  badgeView,
  historyRows,
  drawerFooter,
  diffRows,
  diffSummary,
  restoreView,
  releaseListView,
  type GitInfoView,
} from '@core/ui/git/git-view';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');

const info: GitInfoView = {
  kind: 'agent-system',
  id: 'sys_1',
  domain: 'sales',
  name: 'Support triage',
  paths: ['agents/support/'],
  head: {
    sha: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90123456',
    subject: 'agents(sales): set schedule cron support — via mcp:commit_agent_files',
    author: 'Amir Example',
    email: 'amir@example.com',
    at: '2026-11-14T09:00:00.000Z',
    action: 'set schedule cron',
    surface: 'mcp:commit_agent_files',
    actor: 'amir',
    requestId: 'req_1',
  },
  history: [
    {
      sha: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90123456',
      subject: 'agents(sales): set schedule cron support — via mcp:commit_agent_files',
      author: 'Amir Example',
      email: 'amir@example.com',
      at: '2026-11-14T09:00:00.000Z',
      action: 'set schedule cron',
      surface: 'mcp:commit_agent_files',
      actor: 'amir',
      runId: 'run_42',
    },
    {
      sha: '3f81d0c1122334455667788990aabbccddeeff00',
      subject: 'agents(sales): reconcile agent systems sales — via boot:reconcile',
      author: 'Sovereign OS',
      email: 'os@sovereign.local',
      at: '2026-11-01T06:00:00.000Z',
      action: 'reconcile agent systems',
      surface: 'boot:reconcile',
      reason: 'boot-reconcile',
    },
  ],
  truncated: false,
  via: 'trailer+path',
};

test('sha7 and relativeTime are git-shaped and never guess', () => {
  assert.equal(sha7('9c1f2ab3d4e5f6'), '9c1f2ab');
  assert.equal(sha7(''), '');
  assert.equal(relativeTime('not a date'), '');
  assert.equal(relativeTime('2026-11-14T11:59:50.000Z', NOW), 'just now');
  assert.equal(relativeTime('2026-11-14T11:40:00.000Z', NOW), '20 min ago');
  assert.equal(relativeTime('2026-11-14T09:00:00.000Z', NOW), '3 h ago');
  assert.equal(relativeTime('2026-11-11T12:00:00.000Z', NOW), '3 d ago');
  assert.equal(relativeTime('2026-06-01T12:00:00.000Z', NOW), '2026-06-01', 'beyond a month, an absolute date');
});

test('the badge says sha, author and age, and its tooltip carries the whole commit', () => {
  const view = badgeView(info, NOW);
  assert.equal(view.label, '9c1f2ab · Amir Example · 3 h ago');
  assert.equal(view.platform, false);
  assert.match(view.title, /set schedule cron/);
  assert.match(view.title, /via mcp:commit_agent_files/);
  assert.match(view.title, /actor: amir/);
  assert.match(view.title, /git log -- agents\/support\//, 'the tooltip gives the engineer the command');
});

test('the badge LABELS a commit the OS made for itself, rather than showing it as an edit', () => {
  const platform = badgeView({ ...info, head: info.history[1] }, NOW);
  assert.equal(platform.platform, true);
  assert.match(platform.label!, /^3f81d0c \(OS catch-up\) · Sovereign OS/);
  assert.match(platform.title, /was not a person's edit/);
});

test('the badge is honest when there is nothing: not in git, no commit, no repository', () => {
  const absent = badgeView(null, NOW);
  assert.equal(absent.label, null);
  assert.equal(absent.empty, 'not in git');
  const noCommit = badgeView({ ...info, head: null, history: [], via: 'none' }, NOW);
  assert.equal(noCommit.empty, 'no commit yet');
  assert.match(noCommit.title, /Nothing is hidden/);
  const noRepo = badgeView({ ...info, domain: '', paths: [], head: null, history: [], via: 'none' }, NOW);
  assert.equal(noRepo.empty, 'no repository yet');
});

test('M-6: a non-404 refusal keeps the SERVER message instead of claiming "not in git"', () => {
  const wired = badgeView(null, NOW, "versioning is not wired for 'dashboard' yet — its writer lands with stream D");
  assert.equal(wired.label, null);
  assert.equal(wired.empty, 'git unavailable', 'a real gap must not read as "this object is not in git"');
  assert.match(wired.title, /not wired for 'dashboard'/);
  // Only an absent server note falls back to the "not in git" wording.
  assert.equal(badgeView(null, NOW).empty, 'not in git');
  // And a successful read is unaffected by the parameter.
  assert.equal(badgeView(info, NOW, 'ignored because there IS an answer').label, '9c1f2ab · Amir Example · 3 h ago');
});

test('the drawer rows carry action, surface, actor and the OS-catch-up flag', () => {
  const rows = historyRows(info, NOW);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.short, r.action, r.surface, r.platform]),
    [
      ['9c1f2ab', 'set schedule cron', 'mcp:commit_agent_files', false],
      ['3f81d0c', 'reconcile agent systems', 'boot:reconcile', true],
    ],
  );
  assert.equal(rows[0].runId, 'run_42', 'a commit made inside a run says which run');
  assert.deepEqual(historyRows(null, NOW), []);
});

test('the drawer footer says where the object lives, whether the list is complete, and how it was found', () => {
  assert.equal(
    drawerFooter(info),
    'sales: agents/support/ · This is the complete history the scan window covers. · Found by commit trailer and by path.',
  );
  assert.match(drawerFooter({ ...info, truncated: true }), /scan window ran out/);
  assert.match(drawerFooter({ ...info, via: 'path' }), /typically an OS catch-up commit/);
  assert.equal(drawerFooter(null), 'Not in git.');
});

test('diffRows classifies the patch lines without rewriting them', () => {
  const patch = ['--- a/f.yml', '+++ b/f.yml', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '\\ No newline at end of file', ''].join('\n');
  assert.deepEqual(
    diffRows(patch).map((r) => r.kind),
    ['file', 'file', 'hunk', 'context', 'remove', 'add', 'context', 'note'],
  );
  assert.deepEqual(diffRows(patch).map((r) => r.text).filter((t) => t.startsWith('+') && !t.startsWith('+++')), ['+B']);
});

test('M-3/M-1: a binary file and a redaction are rendered as statements, never as content', () => {
  const binary = ['--- a/logo.png', '+++ b/logo.png', 'Binary files a/logo.png and b/logo.png differ', ''].join('\n');
  assert.deepEqual(diffRows(binary).map((r) => r.kind), ['file', 'file', 'binary']);
  const summary = diffSummary([
    { path: 'logo.png', status: 'modified', patch: binary, binary: true },
    { path: 'system.yaml', status: 'modified', patch: ['--- a/system.yaml', '+++ b/system.yaml', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'), redacted: true },
  ]);
  assert.match(summary, /2 files changed, 1 insertion\(\+\), 1 deletion\(-\)/, 'the binary file contributes no line counts');
  assert.match(summary, /1 binary file not shown/);
  assert.match(summary, /REDACTED by the OS/);
});

test('diffSummary counts only real insertions and deletions, and names "no change" as such', () => {
  const patch = ['--- a/f.yml', '+++ b/f.yml', '@@ -1,2 +1,3 @@', ' a', '-b', '+B', '+c', ''].join('\n');
  assert.equal(diffSummary([{ path: 'f.yml', status: 'modified', patch }]), '1 file changed, 2 insertions(+), 1 deletion(-)');
  assert.equal(diffSummary([]), 'No change: the object is byte-identical at both commits.');
});

test('the four restore states — available, head, unsupported, refused', () => {
  const available = restoreView({ info, sha: '3f81d0c1122334455667788990aabbccddeeff00', restorable: true });
  assert.equal(available.state, 'available');
  assert.equal(available.disabled, false);
  assert.equal(available.phrase, 'restore 3f81d0c');
  assert.match(available.note, /NEW commit on top — nothing in the history is rewritten/);

  const head = restoreView({ info, sha: info.head!.sha, restorable: true });
  assert.equal(head.state, 'head');
  assert.equal(head.disabled, true);

  const unsupported = restoreView({ info, sha: '3f81d0c', restorable: false });
  assert.equal(unsupported.state, 'unsupported');
  assert.equal(unsupported.disabled, true);
  assert.match(unsupported.note, /own write path/, 'the refusal is SHOWN, not hidden behind a missing button');

  const refused = restoreView({ info, sha: '3f81d0c', restorable: true, error: "no agent-system 'sys_1'" });
  assert.equal(refused.state, 'refused');
  assert.equal(refused.note, "no agent-system 'sys_1'");

  const nothing = restoreView({ info: null, sha: '', restorable: true });
  assert.equal(nothing.label, null, 'with no version there is no button at all');
});

test('the release panel is HIDDEN when the tag API is unavailable, and empty-with-a-reason when it is', () => {
  assert.equal(releaseListView({ available: false, releases: [] }).visible, false);
  const empty = releaseListView({ available: true, releases: [] });
  assert.equal(empty.visible, true);
  assert.match(empty.note, /No release tag yet/);
  const one = releaseListView({
    available: true,
    releases: [{ tag: 'app/orders/v1.2.0', sha: '9c1f2ab3d4', at: '2026-11-14T09:00:00.000Z', author: 'Amir Example', message: 'first cut' }],
    now: NOW,
  });
  assert.deepEqual(one.rows, [
    { tag: 'app/orders/v1.2.0', version: 'v1.2.0', short: '9c1f2ab', when: '3 h ago', author: 'Amir Example', message: 'first cut' },
  ]);
  assert.equal(one.note, '');
});
