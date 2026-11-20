/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The WP-55 independent verifier's probes, kept as assertions
 * USER STORY: As the owner I want every probe the verifier ran against WP-55 to stay a test, so a
 *             later change that re-opens a hole it found fails CI by name.
 * ARCHITECTURE:
 *   - Probe 1 (auth): every URL shape the verifier tried, decided exactly as the route decides it
 *     (`originalRequestUri` from `X-Original-URL`, then `authenticateGitRequest`).
 *   - Probe 2 (migration): dry run writes nothing (bytes + mtimes), apply is idempotent, `git revert`
 *     restores the pre-migration tree, and the two rollback facts the procedure depends on: the
 *     receive gate refuses the revert as a push, and a boot that still says `apply` re-migrates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { authenticateGitRequest, type GitPrincipal } from '@core/auth/git-http-auth';
import { __resetAccessTokens, createAccessToken } from '@core/auth/access-tokens-store';
import { originalRequestUri } from '@core/infra/git-original-uri';
import { userRepoName, legacyPersonalAgentLane } from '@core/infra/repo-layout';
import { commitTree, reserveSubtree, repoPath } from '@core/infra/git-store';
import { migrateRepoLayout } from '@core/infra/repo-layout-migrate';
import { decidePath } from '@core/infra/git-receive';

const A: GitPrincipal = { id: 'alice@example.com', name: 'A', role: 'creator', domains: ['sales'] };
const B: GitPrincipal = { id: 'bob@example.com', name: 'B', role: 'domain_admin', domains: ['sales'] };
const R: GitPrincipal = { id: 'root@example.com', name: 'R', role: 'admin', domains: [] };
const people = new Map([A, B, R].map((p) => [p.id, p]));

test('verifier probe 1: every URL shape is decided on the repository it really names', async () => {
  __resetAccessTokens();
  const tok = new Map<string, string>();
  for (const p of [A, B, R]) tok.set(p.id, createAccessToken({ userId: p.id, name: 't' }).token);
  const ua = userRepoName(A.id);
  const decide = async (who: GitPrincipal, raw: string) => {
    const uri = originalRequestUri({ get: (n: string) => (n === 'x-original-url' ? `https://os.example${raw}` : null) }, 'http://x/');
    const o = await authenticateGitRequest({ authorization: `Basic ${Buffer.from(`git:${tok.get(who.id)}`).toString('base64')}`, uri }, { lookup: async (id) => people.get(id) ?? null });
    return o.ok;
  };
  const cases: [GitPrincipal, string, boolean][] = [
    [A, `/git/${ua}.git/info/refs?service=git-upload-pack`, true],
    [B, `/git/${ua}.git/info/refs?service=git-upload-pack`, false],
    [R, `/git/${ua}.git/info/refs?service=git-upload-pack`, true],
    [B, `/git/${ua.toUpperCase()}.git/info/refs?service=git-upload-pack`, false],
    [B, `/git/User-${ua.slice(5)}.git/info/refs`, false],
    [B, `/git/sales.git/../${ua}.git/info/refs?service=git-upload-pack`, false],
    [B, `/git/domain-sales.git/%2e%2e/${ua}.git/info/refs`, false],
    [B, `/git/domain-sales.git/%2E%2E/%2e%2e/git/${ua}.git/info/refs`, false],
    [B, `/git/sales.git%2f..%2f${ua}.git/info/refs`, false],
    [B, `/git/sales.git/..%2f${ua}.git/info/refs`, false],
    [B, `/git//${ua}.git/info/refs`, false],
    [B, `/git/${ua}/info/refs`, false],
    [B, '/git/platform.git/info/refs', false],
    [B, '/git/sales.git/info/refs', true],
    [B, '/git/domain-sales.git/info/refs', true],
    [B, `/git/./${ua}.git/info/refs`, false],
  ];
  for (const [who, raw, allowed] of cases) assert.equal(await decide(who, raw), allowed, `${who.role} ${raw}`);
});

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir(), GIT_AUTHOR_NAME: 'v', GIT_AUTHOR_EMAIL: 'v@v', GIT_COMMITTER_NAME: 'v', GIT_COMMITTER_EMAIL: 'v@v' };
const g = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.push(`L ${p} -> ${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) {
        out.push(`D ${p}`);
        walk(p);
      } else out.push(`F ${p} ${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')} ${fs.statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

test('verifier probe 2: dry run, idempotency and the rollback facts', async () => {
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v55-'));
  reserveSubtree('agents/');
  const file = path.join(process.cwd(), 'tabs/data/lib/dbt/fixtures/composition-with-tests.golden.json');
  const tree = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>));
  tree.set('agents/index.yml', 'version: 1\nsystems: []\n');
  tree.set('agents/shared-bot/system.yaml', 'name: shared\n');
  tree.set(`${legacyPersonalAgentLane(A.id)}my-bot/system.yaml`, 'name: mine\n');
  await commitTree('sales', tree, { author: { name: 'A', email: 'a@a' }, message: 'first', reposDir, timestamp: 1_700_000_000 });

  const s0 = snapshot(reposDir);
  await migrateRepoLayout('sales', { reposDir, dryRun: true });
  assert.equal(snapshot(reposDir), s0, 'a dry run writes nothing');

  const r1 = await migrateRepoLayout('sales', { reposDir });
  assert.ok(r1.sha);
  const heads = () => [repoPath('sales', { reposDir }), repoPath(userRepoName(A.id), { reposDir })].map((d) => g(['--git-dir', d, 'rev-parse', 'main']).trim());
  const h1 = heads();
  const s2 = snapshot(reposDir);
  const r2 = await migrateRepoLayout('sales', { reposDir });
  assert.equal(r2.sha, null);
  assert.equal(r2.alreadyMigrated, true);
  assert.deepEqual(heads(), h1);
  assert.equal(snapshot(reposDir), s2, 'a second apply changes nothing on disk');

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'v55wt-'));
  g(['clone', '-q', path.join(reposDir, 'sales.git'), wt]);
  const pre = g(['rev-parse', 'HEAD~1^{tree}'], wt).trim();
  g(['revert', '--no-edit', 'HEAD'], wt);
  assert.equal(g(['rev-parse', 'HEAD^{tree}'], wt).trim(), pre, 'git revert restores the pre-migration tree exactly');
  const changed = g(['diff', '--name-only', 'HEAD~1', 'HEAD'], wt).trim().split('\n');
  const admin = { id: R.id, role: 'admin' as const, domains: [] as string[] };
  assert.ok(changed.some((p) => !decidePath(p, admin, { layout: 2, repoKind: 'domain' }).allowed), 'the receive gate refuses the revert as a push — the rollback fetches it into the bare repo');
  assert.ok(changed.some((p) => p.includes('agents/personal/')), 'a revert puts the personal lanes back into the domain repo');
  // simulate the PVC-level landing of the revert (a fetch into the bare repo)
  g(['--git-dir', repoPath('sales', { reposDir }), 'fetch', '-q', wt, 'HEAD:refs/heads/main']);
  const r3 = await migrateRepoLayout('sales', { reposDir });
  assert.ok(r3.sha, 'a boot that still says apply re-migrates a reverted repo — so migration: off goes live FIRST');
});
