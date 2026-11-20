/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-56 commit-path hand-off and the live inventory, against real repositories
 * USER STORY: As the owner I want proof that a commit queues its repository for a bundle without
 *             waiting for it or failing because of it, and that the drill's "live" side reports
 *             exactly what git itself reports.
 * ARCHITECTURE:
 *   - Real isomorphic-git commits in a mkdtemp root; the inventory is compared with the git CLI's
 *     own `git for-each-ref` (the command the drill uses on the restored side).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTree, repoPath } from '@core/infra/git-store';
import { backupInventory, markerName, notifyCommitted, repoKeyFor } from '@core/infra/git-backup';

const author = { name: 'A', email: 'a@example.test' };
const tick = () => new Promise((r) => setImmediate(r));
/** Wait (bounded, 5 s) until `done()` holds: the marker is written by async fs calls off the commit path. */
const until = async (done: () => boolean) => {
  const end = Date.now() + 5000;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  await tick();
};

test('a commit queues its repository AFTER it returns (never awaited), coalesced to one marker', async () => {
  const reposDir = mkdtempSync(join(tmpdir(), 'wp56-repos-'));
  const queue = join(mkdtempSync(join(tmpdir(), 'wp56-q-')), 'queue');
  process.env.GIT_BACKUP_QUEUE_DIR = queue;
  try {
    const r = await commitTree('sales', new Map([['a.txt', '1']]), { reposDir, author, message: 'one' });
    assert.equal(r.changed, true);
    // The commit has returned; the marker is written on a LATER turn of the event loop.
    assert.equal(existsSync(join(queue, 'sales')), false, 'the commit must not wait for the queue write');
    await until(() => existsSync(join(queue, 'sales')));
    assert.equal(readFileSync(join(queue, 'sales'), 'utf8'), 'sales');
    await commitTree('sales', new Map([['a.txt', '2']]), { reposDir, author, message: 'two' });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(execFileSync('ls', [queue], { encoding: 'utf8' }).trim().split('\n'), ['sales']);
  } finally {
    delete process.env.GIT_BACKUP_QUEUE_DIR;
  }
});

test('NEGATIVE: an unwritable queue never fails or blocks the commit', async () => {
  const reposDir = mkdtempSync(join(tmpdir(), 'wp56-repos-'));
  const blocker = join(mkdtempSync(join(tmpdir(), 'wp56-q-')), 'not-a-dir');
  writeFileSync(blocker, 'x'); // the queue path is a FILE: mkdir/write must fail
  process.env.GIT_BACKUP_QUEUE_DIR = blocker;
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: unknown) => errors.push(String(m));
  try {
    const r = await commitTree('sales', new Map([['a.txt', '1']]), { reposDir, author, message: 'one' });
    assert.equal(r.changed, true);
    await until(() => errors.some((e) => e.includes('could not queue')));
    assert.ok(errors.some((e) => e.includes('could not queue')), 'the failure is logged, not raised');
  } finally {
    console.error = orig;
    delete process.env.GIT_BACKUP_QUEUE_DIR;
  }
});

test('an alias (a symlink to another repo dir, repo-layout) queues the key of the REAL directory only', async () => {
  const reposDir = mkdtempSync(join(tmpdir(), 'wp56-repos-'));
  const queue = join(mkdtempSync(join(tmpdir(), 'wp56-q-')), 'queue');
  await commitTree('domain-sales', new Map([['a.txt', '1']]), { reposDir, author, message: 'one' });
  // Whichever name the store wrote is the real directory; the other name becomes its alias.
  const isLink = (n: string) => existsSync(join(reposDir, n)) && lstatSync(join(reposDir, n)).isSymbolicLink();
  const realName = ['domain-sales.git', 'sales.git'].find((n) => existsSync(join(reposDir, n)) && !isLink(n)) as string;
  const aliasName = realName === 'sales.git' ? 'domain-sales.git' : 'sales.git';
  if (!existsSync(join(reposDir, aliasName))) symlinkSync(realName, join(reposDir, aliasName));
  assert.equal(notifyCommitted(join(reposDir, aliasName), { reposDir, queueDir: queue }), true);
  const realKey = realName.slice(0, -4);
  await until(() => existsSync(join(queue, realKey)));
  assert.deepEqual(readdirSync(queue), [realKey]);
  const inv = await backupInventory(reposDir);
  assert.deepEqual(inv.repos.map((r) => r.key), [realKey], 'the alias is not a second repository');
  assert.deepEqual(inv.aliases, [{ key: aliasName.slice(0, -4), target: realKey }], 'but it is reported, so an old bundle key is recognised');
});

test('backups off (no queue dir) ⇒ nothing is scheduled; keys outside the root are refused', () => {
  assert.equal(notifyCommitted('/repos/sales.git', { queueDir: null }), false);
  assert.equal(repoKeyFor('/repos/sales.git', '/repos'), 'sales');
  assert.equal(repoKeyFor('/repos/users/alex.git', '/repos'), 'users/alex');
  assert.equal(repoKeyFor('/etc/passwd.git', '/repos'), null);
  assert.equal(repoKeyFor('/repos/sales', '/repos'), null);
  assert.equal(markerName('users/alex'), 'users__alex');
});

test('the live inventory equals `git for-each-ref` for every repository kind, nested ones included', async () => {
  const reposDir = mkdtempSync(join(tmpdir(), 'wp56-repos-'));
  await commitTree('sales', new Map([['a.txt', '1']]), { reposDir, author, message: 'one' });
  const sales = repoPath('sales', { reposDir });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
  execFileSync('git', ['--git-dir', sales, 'tag', '-a', 'v1', '-m', 'v1', 'refs/heads/main'], { env });
  execFileSync('git', ['--git-dir', sales, 'branch', 'feature', 'main'], { env });
  // a nested repository (repo-layout: users/<id>) written by the git CLI
  const nested = join(reposDir, 'users', 'alex.git');
  mkdirSync(join(reposDir, 'users'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', nested]);
  const work = mkdtempSync(join(tmpdir(), 'wp56-w-'));
  execFileSync('git', ['clone', '-q', nested, work], { env, stdio: 'ignore' });
  writeFileSync(join(work, 'f'), 'x');
  execFileSync('git', ['-C', work, 'add', 'f'], { env });
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', 'm'], { env });
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main'], { env, stdio: 'ignore' });

  const inv = await backupInventory(reposDir);
  assert.deepEqual(inv.repos.map((r) => r.key), ['sales', 'users/alex']);
  for (const r of inv.repos) {
    const cli = execFileSync('git', ['--git-dir', join(reposDir, `${r.key}.git`), 'for-each-ref', '--format=%(objectname) %(refname)'], { encoding: 'utf8' })
      .trim().split('\n').sort();
    const ours = Object.entries(r.refs).map(([ref, oid]) => `${oid} ${ref}`).sort();
    assert.deepEqual(ours, cli, `inventory of ${r.key} must equal git for-each-ref`);
  }
  assert.ok(inv.repos[0].refs['refs/tags/v1'], 'annotated tag listed (unpeeled)');
});
