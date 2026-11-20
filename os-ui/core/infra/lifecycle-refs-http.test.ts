/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra
 * FEATURE:    WP-51 eject test — a plain `git clone` with a per-user token shows the lifecycle the OS shows
 * USER STORY: As an engineer I want `git clone https://<os>/git/<repo>.git` with MY access token to
 *             show exactly what the OS says is Live and in Testing, and every version that went live
 *             — as ordinary git tags — and I want a read-only or repo-scoped token to be honoured,
 *             a revoked one refused, and a stranger's clone refused, exactly as before.
 * ARCHITECTURE:
 *   - The OS writes through its own code (`setLivePin`, `markTesting`, `clearLivePin`) into bare
 *     repos in a temp dir. The CLIENT is the real `git` binary; nothing of the OS reads the clone.
 *   - The SERVER: a `node:http` server plays the Ingress — every request is decided by
 *     `authenticateGitRequest` (what `/api/git/authenticate` runs as the `auth-url` sub-request)
 *     and only then handed to git's own http-backend. With `GIT_HTTP_IMAGE` set (CI job
 *     `git-http-image`) the backend is the git-http IMAGE itself (lighttpd + git-http-backend,
 *     the repos bind-mounted read-only); otherwise git's `git http-backend` CGI from the local git.
 *   - Negative twins: a tag deleted or created with PLAIN git in the bare repo changes what the
 *     OS reports (so the status cannot be a second store); a read-only token cannot push; a
 *     scoped token cannot read another repo; a revoked token is a 401; a non-member is refused.
 *   - Skipped (with the reason) locally when no backend is available; under CI it must run.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { commitTree, commitSubtree, ensureV2Repo, mainSha } = await import('@core/infra/git-store');
const { authenticateGitRequest } = await import('@core/auth/git-http-auth');
const { __resetAccessTokens, createAccessToken, revokeAccessToken } = await import('@core/auth/access-tokens-store');
const { userRepoName } = await import('@core/infra/repo-layout');
const pins = await import('@core/infra/lifecycle-pins');

type Principal = { id: string; name: string; role: string; domains: string[] };
const run = promisify(execFile);

const ALICE: Principal = { id: 'alice@example.com', name: 'Alice', role: 'creator', domains: ['sales'] };
const EVE: Principal = { id: 'eve@example.com', name: 'Eve', role: 'builder', domains: ['finance'] };
const people = new Map([ALICE, EVE].map((p) => [p.id, p]));
const lookup = async (id: string) => people.get(id) ?? null;
const author = { name: 'Sovereign OS', email: 'os@sovereign.local' };
const IMAGE = process.env.GIT_HTTP_IMAGE ?? '';

let reposDir = '';
let work = '';
let server: Server | null = null;
let base = '';
let skip = '';
let backend: { kind: 'cgi'; path: string } | { kind: 'image'; port: number; name: string } | null = null;
const tok: Record<string, string> = {};

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

async function git(args: string[], cwd?: string): Promise<string> {
  const r = await run('git', args, { env: gitEnv, cwd });
  return r.stdout;
}

async function tryGit(args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await run('git', args, { env: gitEnv, cwd });
    return { ok: true, out: `${r.stdout}${r.stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function url(token: string, repo: string): string {
  return `http://git:${token}@${base.slice('http://'.length)}/git/${repo}.git`;
}

async function clone(token: string, repo: string): Promise<{ ok: boolean; out: string; dir: string }> {
  const dir = path.join(work, `c-${Math.random().toString(36).slice(2)}`);
  const r = await tryGit(['clone', '-q', url(token, repo), dir]);
  return { ...r, dir };
}

/** What the CLONE says, with git alone: `<tag> <OS-Ref trailer>` per lifecycle tag. */
async function lifecycleInClone(dir: string, prefix: 'live' | 'testing'): Promise<Map<string, string>> {
  const out = await git(['for-each-ref', '--format=%(refname:strip=2)%09%(trailers:key=OS-Ref,valueonly,separator=)', `refs/tags/${prefix}`], dir);
  const m = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, ref] = line.split('\t');
    const [, kind, id] = name.split('/');
    m.set(`${kind}:${id}`, (ref ?? '').trim());
  }
  return m;
}

/** What the OS says, for one repo, read fresh. */
async function lifecycleInOs(repo: string): Promise<{ live: Map<string, string>; testing: Map<string, string> }> {
  pins.__resetLifecyclePins();
  const index = await pins.hydrateForTests({ reposDir });
  const live = new Map<string, string>();
  for (const [k, p] of Object.entries(index.pins)) if (p.domain === repo) live.set(k, p.ref);
  const testing = new Map<string, string>();
  // Test markers carry no repo in the index; this suite only marks in `sales`.
  if (repo === 'sales') for (const [k, t] of Object.entries(index.tests ?? {})) testing.set(k, t.ref);
  return { live, testing };
}

function forward(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, principal: string): void {
  if (backend?.kind === 'image') {
    const headers: Record<string, string> = {};
    for (const h of ['content-type', 'accept', 'git-protocol', 'content-encoding', 'content-length']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const up = httpRequest({ host: '127.0.0.1', port: backend.port, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
    return;
  }
  const [p, query = ''] = (req.url ?? '').split('?');
  const cgi = spawn((backend as { path: string }).path, [], {
    env: {
      ...gitEnv,
      GIT_PROJECT_ROOT: reposDir,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: p.replace(/^\/git/, ''),
      QUERY_STRING: query,
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      REMOTE_USER: principal,
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(cgi.stdin);
  const chunks: Buffer[] = [];
  cgi.stdout.on('data', (c: Buffer) => chunks.push(c));
  cgi.on('close', () => {
    const all = Buffer.concat(chunks);
    const sep = all.indexOf('\r\n\r\n');
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of all.subarray(0, sep).toString('utf8').split('\r\n')) {
      const i = line.indexOf(':');
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]);
      else if (k) headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(all.subarray(sep + 4));
  });
}

before(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp51-repos-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'wp51-work-'));
  fs.chmodSync(reposDir, 0o755);

  if (IMAGE) {
    if (spawnSync('docker', ['image', 'inspect', IMAGE]).status !== 0) {
      if (process.env.CI) throw new Error(`image ${IMAGE} is not present — the CI job must build it first`);
      skip = `image ${IMAGE} is not present`;
      return;
    }
    const name = `wp51-git-http-${process.pid}`;
    const uid = `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`;
    // The image as shipped, with the repos mounted read-only and run as the repos' owner (git
    // refuses a repository owned by another uid, as the PVC is owned by the pod's user).
    const r = spawnSync('docker', ['run', '-d', '--name', name, '--user', uid, '--tmpfs', '/tmp', '-v', `${reposDir}:/repos:ro`, '-p', '127.0.0.1::9419', IMAGE], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
    const port = Number(spawnSync('docker', ['port', name, '9419/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0].split(':').pop());
    backend = { kind: 'image', port, name };
  } else {
    try {
      const p = path.join((await git(['--exec-path'])).trim(), 'git-http-backend');
      if (fs.existsSync(p)) backend = { kind: 'cgi', path: p };
    } catch {
      /* no git */
    }
    if (!backend) {
      if (process.env.CI) throw new Error('git http-backend is not available under CI');
      skip = 'git http-backend is not available';
      return;
    }
  }

  __resetAccessTokens();
  tok.aliceWrite = createAccessToken({ userId: ALICE.id, name: 'laptop' }).token;
  tok.aliceRead = createAccessToken({ userId: ALICE.id, name: 'ci export', access: 'read' }).token;
  tok.aliceSalesOnly = createAccessToken({ userId: ALICE.id, name: 'sales only', access: 'read', repos: ['sales'] }).token;
  const revoked = createAccessToken({ userId: ALICE.id, name: 'old laptop', access: 'read' });
  revokeAccessToken(ALICE.id, revoked.record.id);
  tok.aliceRevoked = revoked.token;
  tok.eve = createAccessToken({ userId: EVE.id, name: 'laptop', access: 'read' }).token;

  // Seed: the sales domain repo (a dbt file and an agent definition), and Alice's personal repo.
  await commitTree('sales', new Map([['dbt_project.yml', 'name: sales\n'], ['agents/bot/system.yaml', 'name: bot\nversion: 1\n']]), { author, message: 'seed', reposDir });
  await ensureV2Repo(userRepoName(ALICE.id), { reposDir });
  await commitSubtree(userRepoName(ALICE.id), 'agents/', new Map([['agents/mine/system.yaml', 'name: mine\n']]), { author, message: 'agents: seed', reposDir });

  // The OS's own writers — the only way the lifecycle is ever set.
  await pins.hydrateForTests({ reposDir });
  const agentSha = (await mainSha('sales', { reposDir }))!;
  await pins.setLivePin('agent', 'bot', agentSha, ALICE, 'sales', { surface: 'test' }, 'agents/bot/system.yaml');
  await pins.setLivePin('dataset', 'ds_orders', 'rev:0123456789ab', ALICE, 'sales', { surface: 'test' });
  await pins.setLivePin('dataset', 'ds_orders', 'rev:ba9876543210', ALICE, 'sales', { surface: 'test' }); // a second go-live
  await pins.setLivePin('dashboard', 'dash_tmp', 'spec:feedfeedfeed', ALICE, 'sales', { surface: 'test' });
  await pins.clearLivePin('dashboard', 'dash_tmp', ALICE, 'sales', { surface: 'test' });
  await pins.markTesting('metric', 'm_rev', 'rev:aaaaaaaaaaaa', 'sales', ALICE);
  const mineSha = (await mainSha(userRepoName(ALICE.id), { reposDir }))!;
  await pins.setLivePin('agent', 'mine', mineSha, ALICE, userRepoName(ALICE.id), { surface: 'test' });

  // The ingress: the OS's auth decision first, then the real git server.
  server = createServer((req, res) => {
    void (async () => {
      const decision = await authenticateGitRequest({ authorization: req.headers.authorization ?? null, uri: req.url ?? '' }, { lookup });
      if (!decision.ok) {
        res.writeHead(decision.status, decision.status === 401 ? { 'www-authenticate': 'Basic realm="os"' } : {});
        res.end(decision.message);
        req.resume();
        return;
      }
      forward(req, res, decision.principal.id);
    })();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  if (backend.kind === 'image') {
    for (let i = 0; i < 60; i++) {
      const r = await clone(tok.aliceRead, 'sales');
      if (r.ok) break;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (backend?.kind === 'image') spawnSync('docker', ['rm', '-f', backend.name]);
  if (reposDir) fs.rmSync(reposDir, { recursive: true, force: true });
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

test('eject: a plain clone with a read-only token shows EXACTLY the live and testing state the OS shows', async (t) => {
  if (skip) return t.skip(skip);
  const c = await clone(tok.aliceRead, 'sales');
  assert.equal(c.ok, true, c.out);
  const os = await lifecycleInOs('sales');
  const live = await lifecycleInClone(c.dir, 'live');
  const testing = await lifecycleInClone(c.dir, 'testing');
  assert.deepEqual([...live].sort(), [...os.live].sort(), 'live: clone == OS');
  assert.deepEqual([...testing].sort(), [...os.testing].sort(), 'testing: clone == OS');
  // And the concrete facts, so an empty == empty cannot pass.
  assert.deepEqual([...live.keys()].sort(), ['agent:bot', 'dataset:ds_orders']);
  assert.equal(live.get('dataset:ds_orders'), 'rev:ba9876543210', 'the SECOND go-live moved the tag');
  assert.equal(testing.get('metric:m_rev'), 'rev:aaaaaaaaaaaa');
  assert.equal(live.has('dashboard:dash_tmp'), false, 'a retired object has no live tag');
});

test('eject: every version that went live is an immutable tag, the retired one included', async (t) => {
  if (skip) return t.skip(skip);
  const c = await clone(tok.aliceRead, 'sales');
  const versions = (await git(['tag', '-l', 'version/*'], c.dir)).split('\n').filter(Boolean).sort();
  assert.deepEqual(versions, ['version/agent/bot/1', 'version/dashboard/dash_tmp/1', 'version/dataset/ds_orders/1', 'version/dataset/ds_orders/2']);
});

test('eject: `git checkout live/agent/bot` is the pinned definition, and `git show` names who and when', async (t) => {
  if (skip) return t.skip(skip);
  const c = await clone(tok.aliceRead, 'sales');
  await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'live/agent/bot'], c.dir);
  assert.equal(fs.readFileSync(path.join(c.dir, 'agents/bot/system.yaml'), 'utf8'), 'name: bot\nversion: 1\n');
  const shown = await git(['tag', '-l', '--format=%(taggername) %(taggerdate:unix) %(trailers:key=OS-Actor,valueonly) %(contents:subject)', 'live/agent/bot'], c.dir);
  assert.match(shown, /alice@example\.com/, 'OS-Actor names who went live');
  assert.match(shown, / \d{10} /, 'the tagger date is when');
  assert.match(shown, /go-live agent:bot/);
  // The summary file in the clone is generated from the same tags.
  const yml = await git(['show', 'origin/main:os/lifecycle/pins.yml'], c.dir);
  assert.match(yml, /id: ds_orders/);
  assert.match(yml, /ref: rev:ba9876543210/);
  assert.doesNotMatch(yml, /dash_tmp/);
});

test('eject: a personal repo carries its owner’s lifecycle tags, readable by its owner', async (t) => {
  if (skip) return t.skip(skip);
  const c = await clone(tok.aliceRead, userRepoName(ALICE.id));
  assert.equal(c.ok, true, c.out);
  assert.deepEqual([...(await lifecycleInClone(c.dir, 'live')).keys()], ['agent:mine']);
  assert.deepEqual([...(await lifecycleInOs(userRepoName(ALICE.id))).live.keys()], ['agent:mine']);
});

test('negative twin: a tag DELETED with plain git is no longer live in the OS — the status is not stored anywhere else', async (t) => {
  if (skip) return t.skip(skip);
  const bare = path.join(reposDir, 'sales.git');
  await git(['--git-dir', bare, 'tag', '-d', 'live/agent/bot']);
  try {
    const os = await lifecycleInOs('sales');
    assert.equal(os.live.has('agent:bot'), false, 'the OS reads git; a mirror would still say Live');
    assert.equal(os.live.has('dataset:ds_orders'), true);
  } finally {
    // Put it back exactly as it was for the other tests (the version tag still names the commit).
    await git(['--git-dir', bare, 'tag', 'live/agent/bot', 'version/agent/bot/1']);
  }
});

test('negative twin: a lifecycle tag CREATED with plain git is what the OS reports', async (t) => {
  if (skip) return t.skip(skip);
  const bare = path.join(reposDir, 'sales.git');
  await git(['--git-dir', bare, '-c', 'user.name=Ops', '-c', 'user.email=ops@example.com', 'tag', '-a', 'live/connection/c_pg', '-m', 'go-live connection:c_pg\n\nOS-Ref: rev:c0ffeec0ffee', 'main']);
  try {
    const os = await lifecycleInOs('sales');
    assert.equal(os.live.get('connection:c_pg'), 'rev:c0ffeec0ffee');
  } finally {
    await git(['--git-dir', bare, 'tag', '-d', 'live/connection/c_pg']);
  }
});

test('token scope: a READ-ONLY token cannot push; the refusal comes from the OS, before git runs', async (t) => {
  if (skip) return t.skip(skip);
  const c = await clone(tok.aliceRead, 'sales');
  fs.writeFileSync(path.join(c.dir, 'x.txt'), 'x\n');
  await git(['add', 'x.txt'], c.dir);
  await git(['-c', 'user.name=A', '-c', 'user.email=a@example.com', 'commit', '-qm', 'x'], c.dir);
  const push = await tryGit(['push', '-q', 'origin', 'HEAD:main'], c.dir);
  assert.equal(push.ok, false, push.out);
  assert.match(push.out, /403|read-only/i);
});

test('token scope: a token narrowed to `sales` cannot read its owner’s personal repo', async (t) => {
  if (skip) return t.skip(skip);
  assert.equal((await clone(tok.aliceSalesOnly, 'sales')).ok, true);
  const r = await clone(tok.aliceSalesOnly, userRepoName(ALICE.id));
  assert.equal(r.ok, false, 'the owner may read it, but this token may not');
  assert.equal((await clone(tok.aliceRead, userRepoName(ALICE.id))).ok, true, 'an unscoped token of the same owner may');
});

test('token scope: a REVOKED token is a 401, and a non-member is refused the domain repo (unchanged)', async (t) => {
  if (skip) return t.skip(skip);
  const revoked = await clone(tok.aliceRevoked, 'sales');
  assert.equal(revoked.ok, false);
  assert.match(revoked.out, /401|Authentication failed|could not read Username|terminal prompts disabled/i);
  const eve = await clone(tok.eve, 'sales');
  assert.equal(eve.ok, false, 'finance may not read sales');
  assert.match(eve.out, /404|not found|no such repository/i);
});
