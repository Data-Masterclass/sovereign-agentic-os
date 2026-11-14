/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An app's source tree lives in the domain repository under `apps/<slug>/` (night-2 S5)
 * USER STORY: As an engineer I want the sha, the author and the trailers of the commit that holds
 *             my app's files, and I want pushing identical files twice to make ONE commit.
 * ARCHITECTURE: Real isomorphic-git in a temp dir through the real `commitSubtree`, plus the pure
 *             helpers. No cluster, no OpenSearch (the mirror is not touched here).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, listTree, reservedSubtrees, __clearReservedSubtrees, GitStoreError } from '@core/infra/git-store';
import {
  APPS_PREFIX,
  appSubtreePrefix,
  appTreeFiles,
  appCommitMessage,
  commitAppTree,
  gitCommitNote,
  installAppTreeReservation,
  appProjectGitEnabled,
  __setAppProjectGitForTests,
} from './git-commit.ts';

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-apps-'));
  __setAppProjectGitForTests(true);
});
after(() => {
  __setAppProjectGitForTests(null);
  rmSync(reposDir, { recursive: true, force: true });
});

const app = { id: 'app_abc123', slug: 'invoices', name: 'Invoices', domain: 'eng' };
const alex = { id: 'alex', name: 'Alexander Borek', email: 'alex@datamasterclass.com' };
const files = [
  { path: 'app.yaml', content: 'name: Invoices\n' },
  { path: 'src/App.tsx', content: 'export default () => null;\n' },
];

test('appSubtreePrefix: `apps/<slug>`, and an unsafe slug never reaches the filesystem', () => {
  assert.equal(APPS_PREFIX, 'apps/');
  assert.equal(appSubtreePrefix('invoices'), 'apps/invoices');
  assert.equal(appSubtreePrefix('INVOICES'), 'apps/invoices');
  for (const bad of ['', '..', 'a/b', '../etc', '-lead', 'x'.repeat(70), 'has space']) {
    assert.throws(() => appSubtreePrefix(bad), GitStoreError, `rejects '${bad}'`);
  }
});

test('appTreeFiles: prefixes every path, and REFUSES one that escapes the subtree', () => {
  const tree = appTreeFiles('invoices', files);
  assert.deepEqual([...tree.keys()].sort(), ['apps/invoices/app.yaml', 'apps/invoices/src/App.tsx']);
  for (const bad of ['/abs.txt', '../escape.txt', 'a//b.txt', './x.txt', '']) {
    assert.throws(() => appTreeFiles('invoices', [{ path: bad, content: '' }]), GitStoreError, `rejects '${bad}'`);
  }
});

test('appCommitMessage: the subject names the action + slug + surface, and carries the four trailers', () => {
  const msg = appCommitMessage(app, { action: 'push_app_files', surface: 'mcp:push_app_files', requestId: 'req_1', note: 'add the list page' }, 'eng');
  assert.match(msg.split('\n')[0], /^software\(eng\): push_app_files invoices — add the list page — via mcp:push_app_files$/);
  assert.match(msg, /^OS-Action: push_app_files$/m);
  assert.match(msg, /^OS-Object: app:app_abc123 \(Invoices\)$/m);
  assert.match(msg, /^OS-Surface: mcp:push_app_files$/m);
  assert.match(msg, /^OS-Request-Id: req_1$/m);
});

test('commitAppTree: commits under apps/<slug>/ as the user; the SAME files twice = ONE commit', async () => {
  const first = await commitAppTree(app, alex, files, { action: 'push_app_files', surface: 'mcp:push_app_files' }, { reposDir, mirror: false });
  assert.equal(first.ok, true);
  assert.equal(first.recorded, true);
  assert.equal(first.ok && first.recorded && first.changed, true);
  const sha = first.ok && first.recorded ? first.sha : '';
  assert.match(sha, /^[0-9a-f]{40}$/);

  const entries = await listTree('eng', 'main', { reposDir });
  assert.deepEqual(entries.map((e) => e.path).sort(), ['apps/invoices/app.yaml', 'apps/invoices/src/App.tsx']);

  const head = (await log('eng', { reposDir, limit: 1 }))[0];
  assert.equal(head.author.name, 'Alexander Borek', 'the ACTING USER is the author');
  assert.equal(head.author.email, 'alex@datamasterclass.com');
  assert.equal(head.committer.name, 'Sovereign OS');
  assert.equal(head.trailers['OS-Object'], 'app:app_abc123 (Invoices)');
  assert.equal(head.trailers['OS-Actor'], 'alex');

  // IDEMPOTENT: identical bytes ⇒ no second commit.
  const again = await commitAppTree(app, alex, files, { action: 'push_app_files' }, { reposDir, mirror: false });
  assert.equal(again.ok && again.recorded && again.changed, false, 'changed: false');
  assert.equal(again.ok && again.recorded ? again.sha : '', sha, 'the same head');
  assert.equal((await log('eng', { reposDir, limit: 10 })).length, 1, 'ONE commit for two identical pushes');

  // A real change IS a second commit, by whoever made it.
  const sam = { id: 'sam@acme.com', name: 'Sam' };
  const changed = await commitAppTree(app, sam, [...files, { path: 'README.md', content: '# Invoices\n' }], { action: 'edit' }, { reposDir, mirror: false });
  assert.equal(changed.ok && changed.recorded && changed.changed, true);
  const log2 = await log('eng', { reposDir, limit: 10 });
  assert.equal(log2.length, 2);
  // An id with no e-mail gets a SYNTHESIZED address, and an email-shaped id is not doubled up
  // into `sam@acme.com@os.local` — plus the commit SAYS the address was synthesized.
  assert.equal(log2[0].author.email, 'sam@os.local');
  assert.equal(log2[0].trailers['OS-Author-Email'], 'synthesized');
  assert.equal(log2[0].trailers['OS-Actor'], 'sam@acme.com', 'the real principal id is still recorded');
});

test('commitAppTree: another app in the same domain repo is untouched (one repo per DOMAIN)', async () => {
  const other = { id: 'app_x', slug: 'reports', name: 'Reports', domain: 'eng' };
  await commitAppTree(other, alex, [{ path: 'app.yaml', content: 'name: Reports\n' }], { action: 'push_app_files' }, { reposDir, mirror: false });
  const paths = (await listTree('eng', 'main', { reposDir })).map((e) => e.path);
  assert.ok(paths.includes('apps/invoices/app.yaml'), 'the first app survives');
  assert.ok(paths.includes('apps/reports/app.yaml'), 'the second app lands beside it');
});

test('commitAppTree: honest outcomes — flag off, no domain, and a git failure', async () => {
  __setAppProjectGitForTests(false);
  const off = await commitAppTree(app, alex, files, { action: 'push_app_files' }, { reposDir, mirror: false });
  assert.deepEqual(off, { ok: true, recorded: false, reason: 'the domain git repository is disabled (DATA_PROJECT_GIT=false)' });
  assert.match(gitCommitNote(off), /^⚠ not recorded in git/);
  __setAppProjectGitForTests(true);

  const noDomain = await commitAppTree({ ...app, domain: '' }, alex, files, { action: 'push_app_files' }, { reposDir, mirror: false });
  assert.equal(noDomain.recorded, false);
  assert.match(noDomain.ok ? noDomain.reason : '', /not assigned to a domain/);

  const failed = await commitAppTree(app, alex, files, { action: 'push_app_files' }, {
    reposDir,
    mirror: false,
    committer: async () => {
      throw new Error('disk full');
    },
  });
  assert.equal(failed.ok, false, 'a git failure is REPORTED, never swallowed as success');
  assert.match(failed.reason, /disk full/);
  assert.match(gitCommitNote(failed), /git commit FAILED: disk full/);
  assert.match(gitCommitNote(failed), /mirror cache only/, 'the UI is told the files are cache-only');
});

test('installAppTreeReservation: `apps/` is reserved so a whole-tree writer cannot delete it', () => {
  __clearReservedSubtrees();
  assert.ok(!reservedSubtrees().includes('apps/'));
  installAppTreeReservation();
  assert.ok(reservedSubtrees().includes('apps/'));
  installAppTreeReservation();
  assert.equal(reservedSubtrees().filter((p) => p === 'apps/').length, 1, 'idempotent');
});

test('the flag is Part D’s one switch and is ON unless the environment says otherwise', () => {
  __setAppProjectGitForTests(null);
  assert.equal(appProjectGitEnabled(), true);
  __setAppProjectGitForTests(true);
});
