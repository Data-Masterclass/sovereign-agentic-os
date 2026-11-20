/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       git-http image
 * FEATURE:    The git-http lighttpd refuses encoded path separators and dot segments (layer 2)
 * USER STORY: As a domain member I want the git-http sidecar itself to refuse a path it would
 *             otherwise decode or normalise into a second repository, so the path git-http-backend
 *             serves is always the path the OS authorised (layer 1: os-ui/core/auth/git-http-path.test.ts).
 * ARCHITECTURE:
 *   - Runs the image given in GIT_HTTP_IMAGE (CI job `git-http-image` builds it from the branch)
 *     against two real bare repos, and asks it with curl. No OS code runs.
 *   - Without docker or the image it FAILS under CI and is skipped with the reason locally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const IMAGE = process.env.GIT_HTTP_IMAGE ?? '';
const Q = '?service=git-upload-pack';

test('layer 2: the git-http lighttpd refuses the traversal shapes before git-http-backend runs', (t) => {
  const missing = !IMAGE ? 'GIT_HTTP_IMAGE is not set' : spawnSync('docker', ['image', 'inspect', IMAGE]).status !== 0 ? `image ${IMAGE} is not present` : '';
  if (missing) {
    if (process.env.CI) assert.fail(`${missing} — the CI job must build the image first`);
    t.skip(missing);
    return;
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-http-guard-'));
  const repos = path.join(base, 'repos');
  const src = path.join(base, 'src');
  fs.mkdirSync(repos);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  execFileSync('git', ['init', '-q', src], { env });
  for (const r of ['sales', 'finance']) {
    fs.writeFileSync(path.join(src, 'f'), `${r}\n`);
    execFileSync('git', ['-C', src, 'add', 'f'], { env });
    execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', r], { env });
    execFileSync('git', ['init', '-q', '--bare', path.join(repos, `${r}.git`)], { env });
    execFileSync('git', ['-C', src, 'push', '-q', path.join(repos, `${r}.git`), 'HEAD:refs/heads/main'], { env });
  }
  execFileSync('chmod', ['-R', 'a+rX', base]);
  const name = `git-http-guard-${process.pid}`;
  // The repos are COPIED into the container and handed to its user (65532), as the PVC is in the
  // pod: git refuses a repository owned by another uid ("dubious ownership"), which a bind mount
  // from the runner would be.
  const create = spawnSync('docker', ['create', '--name', name, '-p', '127.0.0.1::9419', IMAGE], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  try {
    const cp = spawnSync('docker', ['cp', `${repos}/.`, `${name}:/repos`], { encoding: 'utf8' });
    assert.equal(cp.status, 0, cp.stderr);
    assert.equal(spawnSync('docker', ['start', name], { encoding: 'utf8' }).status, 0);
    const own = spawnSync('docker', ['exec', '-u', '0', name, 'chown', '-R', '65532:65532', '/repos'], { encoding: 'utf8' });
    assert.equal(own.status, 0, own.stderr);
    const port = spawnSync('docker', ['port', name, '9419/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0].split(':').pop();
    const code = (p) => {
      for (let i = 0; i < 60; i++) {
        const r = spawnSync('curl', ['-s', '--path-as-is', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}${p}`], { encoding: 'utf8' });
        if (r.stdout && r.stdout !== '000') return r.stdout;
        spawnSync('sleep', ['0.5']);
      }
      return '000';
    };
    assert.equal(code(`/git/sales.git/info/refs${Q}`), '200', 'the plain path is served');
    for (const p of [
      `/git/sales.git/..%2ffinance.git/info/refs${Q}`,
      `/git/sales.git/..%2Ffinance.git/info/refs${Q}`,
      `/git/sales.git/%2e%2e%2ffinance.git/info/refs${Q}`,
      `/git/sales.git/%2e%2e/finance.git/info/refs${Q}`,
      `/git/sales.git/../finance.git/info/refs${Q}`,
    ]) {
      assert.equal(code(p), '400', `lighttpd served ${p}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name]);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
