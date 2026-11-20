/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    git-http path guard — encoded separators and dot segments are refused on both layers
 * USER STORY: As a domain member I want a git-over-HTTP request to reach exactly the repository the
 *             OS authorised, so a URL whose path a server decodes or normalises differently can
 *             never name a second repository.
 * ARCHITECTURE:
 *   - Layer 1: `authenticateGitRequest` (the ingress auth-url decision), fed exactly as the route
 *     feeds it (`originalRequestUri` from `X-Original-URL`).
 *   - Layer 2: the git-http sidecar's lighttpd (`images/base/git-http`), built from this tree and
 *     run in docker with git's own `http-backend`; skipped with the reason when docker is absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { authenticateGitRequest, parseGitPath, unsafeGitPath } from '@core/auth/git-http-auth';
import { __resetAccessTokens, createAccessToken } from '@core/auth/access-tokens-store';
import { originalRequestUri } from '@core/infra/git-original-uri';

const MEMBER = { id: 'bob', name: 'Bob', role: 'builder', domains: ['sales'] };
const Q = '?service=git-upload-pack';
const VARIANTS = [
  `/git/sales.git/..%2ffinance.git/info/refs${Q}`,
  `/git/sales.git/..%2Ffinance.git/info/refs${Q}`,
  `/git/sales.git/%2e%2e%2ffinance.git/info/refs${Q}`,
  `/git/sales.git/%2E%2E%2Ffinance.git/info/refs${Q}`,
  `/git/sales.git%2f..%2ffinance.git/info/refs${Q}`,
  `/git/sales.git/..%5cfinance.git/info/refs${Q}`,
  `/git/sales.git/%252e%252e%252ffinance.git/info/refs${Q}`,
  `/git/sales.git//finance.git/info/refs${Q}`,
];

test('layer 1: a member is refused every encoded-separator / dot-segment variant, and served the plain path', async () => {
  __resetAccessTokens();
  const auth = `Basic ${Buffer.from(`git:${createAccessToken({ userId: MEMBER.id, name: 't' }).token}`).toString('base64')}`;
  const decide = async (raw: string) => {
    const uri = originalRequestUri({ get: (n: string) => (n === 'x-original-url' ? `https://os.example${raw}` : null) }, 'http://x/');
    return authenticateGitRequest({ authorization: auth, uri }, { lookup: async () => MEMBER });
  };
  assert.equal((await decide(`/git/sales.git/info/refs${Q}`)).ok, true);
  for (const raw of VARIANTS) {
    const o = await decide(raw);
    assert.equal(o.ok, false, `allowed: ${raw}`);
  }
  // plain `..` is normalised by the URL parser to the repo it really names — which is then judged
  assert.equal((await decide(`/git/sales.git/../finance.git/info/refs${Q}`)).ok, false);
  assert.equal(parseGitPath('/git/sales.git/info/refs')?.domain, 'sales');
  assert.equal(unsafeGitPath('/git/sales.git/objects/ab/cdef'), false);
  assert.equal(unsafeGitPath('/git/sales.git/%zz'), true, 'an undecodable path is refused');
});

test('layer 2: the git-http lighttpd refuses the same shapes before git-http-backend runs', async (t) => {
  if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0) return t.skip('docker is not available');
  const tag = 'wp-git-http-guard:test';
  const ctx = path.resolve(process.cwd(), '../images/base/git-http');
  const build = spawnSync('docker', ['build', '-q', '-t', tag, ctx], { encoding: 'utf8', timeout: 600_000 });
  if (build.status !== 0) return t.skip(`could not build ${ctx}: ${build.stderr.slice(-300)}`);
  const base = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'git-http-guard-'));
  const repos = path.join(base, 'repos');
  fs.mkdirSync(repos);
  const src = path.join(base, 'src');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  execFileSync('git', ['init', '-q', src], { env });
  fs.writeFileSync(path.join(src, 'f'), 'x\n');
  execFileSync('git', ['-C', src, 'add', 'f'], { env });
  execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { env });
  for (const r of ['sales', 'finance']) {
    execFileSync('git', ['init', '-q', '--bare', path.join(repos, `${r}.git`)], { env });
    execFileSync('git', ['-C', src, 'push', '-q', path.join(repos, `${r}.git`), 'HEAD:refs/heads/main'], { env });
  }
  fs.chmodSync(base, 0o755);
  execFileSync('chmod', ['-R', 'a+rX', base]);
  const name = `git-http-guard-${process.pid}`;
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::9419', '-v', `${repos}:/repos:ro`, tag], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  try {
    const port = spawnSync('docker', ['port', name, '9419/tcp'], { encoding: 'utf8' }).stdout.trim().split(':').pop();
    const code = (p: string) => {
      for (let i = 0; i < 40; i++) {
        const r = spawnSync('curl', ['-s', '--path-as-is', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}${p}`], { encoding: 'utf8' });
        if (r.stdout && r.stdout !== '000') return r.stdout;
        spawnSync('sleep', ['0.5']);
      }
      return '000';
    };
    assert.equal(code(`/git/sales.git/info/refs${Q}`), '200');
    for (const p of [`/git/sales.git/..%2ffinance.git/info/refs${Q}`, `/git/sales.git/%2e%2e%2ffinance.git/info/refs${Q}`, `/git/sales.git/../finance.git/info/refs${Q}`, `/git/sales.git/%2e%2e/finance.git/info/refs${Q}`]) {
      assert.equal(code(p), '400', `lighttpd served ${p}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name]);
  }
});
