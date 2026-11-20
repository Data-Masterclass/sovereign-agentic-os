/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The repo boundary IS the read boundary — proved through the real git server path
 * USER STORY: As a person with a personal repository I want `git clone` of MY repo to work and a
 *             clone of anybody else's to be refused — even by a member (or admin) of my domain —
 *             over the authenticated https door AND the in-cluster git daemon (component design 12).
 * ARCHITECTURE:
 *   - HTTPS door: a `node:http` server plays the ingress — every request is first decided by
 *     `authenticateGitRequest` (what `/api/git/authenticate` runs as the ingress `auth-url`
 *     sub-request) and, only when it allows, handed to git's OWN `git http-backend` CGI with
 *     `GIT_PROJECT_ROOT` = the repos dir, exactly as the `git-http` sidecar does. Real tokens from
 *     the real token store. The client is the real `git clone`.
 *   - In-cluster door: the real `git daemon` with the chart's access hook
 *     (`charts/.../files/git/daemon-access-hook.sh`), and the real `git clone git://…`.
 *   - Skipped (with the reason) when `git` or `git http-backend` is not available — never faked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { commitTree, commitSubtree, ensureV2Repo } from '@core/infra/git-store';
import { authenticateGitRequest, type GitPrincipal } from '@core/auth/git-http-auth';
import { __resetAccessTokens, createAccessToken } from '@core/auth/access-tokens-store';
import { userRepoName, PLATFORM_REPO } from '@core/infra/repo-layout';

const run = promisify(execFile);

const ALICE: GitPrincipal = { id: 'alice@example.com', name: 'Alice', role: 'creator', domains: ['sales'] };
const BOB: GitPrincipal = { id: 'bob@example.com', name: 'Bob', role: 'domain_admin', domains: ['sales'] };
const ROOT: GitPrincipal = { id: 'root@example.com', name: 'Root', role: 'admin', domains: [] };
const people = new Map([ALICE, BOB, ROOT].map((p) => [p.id, p]));
const lookup = async (id: string) => people.get(id) ?? null;
const author = { name: 'Sovereign OS', email: 'os@sovereign.local' };

let reposDir = '';
let work = '';
let server: Server | null = null;
let base = '';
let backend = '';
let available = true;
const tokens = new Map<string, string>();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

async function clone(url: string): Promise<{ ok: boolean; out: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(work, 'c-'));
  fs.rmSync(dir, { recursive: true });
  try {
    const r = await run('git', ['clone', '-q', url, dir], { env: gitEnv });
    return { ok: true, out: `${r.stdout}${r.stderr}`, dir };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, dir };
  }
}

function httpUrl(who: GitPrincipal, repo: string): string {
  return `http://git:${tokens.get(who.id)}@${base.slice('http://'.length)}/git/${repo}.git`;
}

before(async () => {
  try {
    const { stdout } = await run('git', ['--exec-path']);
    backend = path.join(stdout.trim(), 'git-http-backend');
    available = fs.existsSync(backend);
  } catch {
    available = false;
  }
  if (!available) return;
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp55-http-repos-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'wp55-http-work-'));
  __resetAccessTokens();
  for (const p of people.values()) tokens.set(p.id, createAccessToken({ userId: p.id, name: 'laptop' }).token);

  // Seed: Alice's and Bob's personal repos, the sales domain repo (legacy name), the platform repo.
  for (const p of [ALICE, BOB]) {
    await ensureV2Repo(userRepoName(p.id), { reposDir });
    await commitSubtree(userRepoName(p.id), 'agents/', new Map([[`agents/${p.name.toLowerCase()}-bot/system.yaml`, `name: ${p.name}\n`]]), { author, message: 'agents: seed', reposDir });
  }
  await commitTree('sales', new Map([['dbt_project.yml', 'name: sales\n']]), { author, message: 'data(sales): seed', reposDir });
  await ensureV2Repo(PLATFORM_REPO, { reposDir });

  // The ingress: auth sub-request first, then git's own CGI.
  server = createServer((req, res) => {
    void (async () => {
      const decision = await authenticateGitRequest({ authorization: req.headers.authorization ?? null, uri: req.url ?? '' }, { lookup });
      if (!decision.ok) {
        res.writeHead(decision.status, decision.status === 401 ? { 'www-authenticate': 'Basic realm="os"' } : {});
        res.end(decision.message);
        req.resume();
        return;
      }
      const [p, query = ''] = (req.url ?? '').split('?');
      const cgi = spawn(backend, [], {
        env: {
          ...gitEnv,
          GIT_PROJECT_ROOT: reposDir,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: p.replace(/^\/git/, ''),
          QUERY_STRING: query,
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
          REMOTE_USER: decision.principal.id,
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      req.pipe(cgi.stdin);
      const chunks: Buffer[] = [];
      cgi.stdout.on('data', (c: Buffer) => chunks.push(c));
      cgi.on('close', () => {
        const all = Buffer.concat(chunks);
        const sep = all.indexOf('\r\n\r\n');
        const head = all.subarray(0, sep).toString('utf8').split('\r\n');
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of head) {
          const i = line.indexOf(':');
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]);
          else if (k) headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(all.subarray(sep + 4));
      });
    })();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (reposDir) fs.rmSync(reposDir, { recursive: true, force: true });
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

test('https: user A clones THEIR user repo', async (t) => {
  if (!available) return t.skip('git http-backend is not available');
  const r = await clone(httpUrl(ALICE, userRepoName(ALICE.id)));
  assert.equal(r.ok, true, r.out);
  assert.equal(fs.readFileSync(path.join(r.dir, 'agents/alice-bot/system.yaml'), 'utf8'), 'name: Alice\n');
  assert.ok(fs.existsSync(path.join(r.dir, 'os/layout.yml')));
  assert.ok(fs.existsSync(path.join(r.dir, 'README.md')), 'the generated root README is there');
});

test('https: user A is REFUSED user B\'s repo (negative twin)', async (t) => {
  if (!available) return t.skip('git http-backend is not available');
  const r = await clone(httpUrl(ALICE, userRepoName(BOB.id)));
  assert.equal(r.ok, false);
  assert.match(r.out, /404|not found|no such repository/i);
});

test('https: a member — even the domain admin — of A\'s domain is REFUSED A\'s user repo', async (t) => {
  if (!available) return t.skip('git http-backend is not available');
  const r = await clone(httpUrl(BOB, userRepoName(ALICE.id)));
  assert.equal(r.ok, false, r.out);
});

test('https: the platform admin may read a user repo; nobody else may read the platform repo', async (t) => {
  if (!available) return t.skip('git http-backend is not available');
  assert.equal((await clone(httpUrl(ROOT, userRepoName(ALICE.id)))).ok, true);
  assert.equal((await clone(httpUrl(BOB, PLATFORM_REPO))).ok, false);
  assert.equal((await clone(httpUrl(ROOT, PLATFORM_REPO))).ok, true);
});

test('https: a domain repo is served to its members under the canonical name and the legacy alias', async (t) => {
  if (!available) return t.skip('git http-backend is not available');
  assert.equal((await clone(httpUrl(ALICE, 'sales'))).ok, true, 'the legacy <domain>.git');
  const outsider: GitPrincipal = { id: 'eve@example.com', name: 'Eve', role: 'builder', domains: ['finance'] };
  people.set(outsider.id, outsider);
  tokens.set(outsider.id, createAccessToken({ userId: outsider.id, name: 'laptop' }).token);
  assert.equal((await clone(httpUrl(outsider, 'sales'))).ok, false, 'a non-member is refused');
});

test('git daemon (in-cluster door): domain repos are served, user and platform repos are refused', async (t) => {
  if (!available) return t.skip('git is not available');
  const hook = path.resolve(process.cwd(), '../charts/sovereign-agentic-os/files/git/daemon-access-hook.sh');
  const port = await freePort();
  const daemon: ChildProcess = spawn(
    'git',
    ['daemon', '--export-all', `--base-path=${reposDir}`, '--reuseaddr', `--port=${port}`, '--listen=127.0.0.1', '--informative-errors', `--access-hook=${hook}`, reposDir],
    { env: gitEnv, stdio: 'ignore' },
  );
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = await new Promise<boolean>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => {
          s.end();
          resolve(true);
        });
        s.on('error', () => resolve(false));
      });
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(up, 'git daemon did not start');
    const ok = await clone(`git://127.0.0.1:${port}/sales.git`);
    assert.equal(ok.ok, true, ok.out);
    const mine = await clone(`git://127.0.0.1:${port}/${userRepoName(ALICE.id)}.git`);
    assert.equal(mine.ok, false, 'a user repo is not served on the unauthenticated git protocol');
    assert.match(mine.out, /not served over the in-cluster git protocol|access denied/i);
    assert.equal((await clone(`git://127.0.0.1:${port}/${PLATFORM_REPO}.git`)).ok, false);
  } finally {
    daemon.kill();
  }
});
