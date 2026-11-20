/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-54: the runner deploys the app's COMMITTED k8s/ manifests (native-deploy.ts) — dry-run
 * first, then for real — and builds no object of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import {
  runnerName,
  deployApp,
  runnerStatus,
  stopApp,
  deleteApp,
  type RunnerApp,
  type RunnerK8s,
} from './runner.ts';
import { appDeployFiles, NOT_BUILT_DIGEST } from './native-deploy.ts';

const REGISTRY = 'registry.example.com/sovereign-os-apps';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const OPTS = { namespace: 'agentic-apps', registry: REGISTRY };
const HOST = 'shop.ops.apps.example.com';

function treeOf(digest = DIGEST, extra: { path: string; content: string }[] = []): RunnerApp {
  const files = [
    { path: 'Dockerfile', content: 'FROM nginxinc/nginx-unprivileged\n' },
    ...appDeployFiles({ slug: 'shop', host: HOST, registry: REGISTRY, digest, ingressClass: 'nginx', tlsIssuer: 'le' }),
    ...extra,
  ];
  return { slug: 'shop', host: HOST, tree: { kind: 'tree', files, sha: 'c0ffee' } };
}
const APP = treeOf();

const NS = OPTS.namespace;
const DEP = `/apis/apps/v1/namespaces/${NS}/deployments`;
const SVC = `/api/v1/namespaces/${NS}/services`;
const ING = `/apis/networking.k8s.io/v1/namespaces/${NS}/ingresses`;
const DRY = '?dryRun=All';

/** A recording mock k8s client driven by a per-`METHOD path` table (+ method fallback). */
function mockK8s(responses: Record<string, { status: number; body?: Record<string, unknown> }>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client: RunnerK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = responses[`${method} ${path}`] ?? responses[method] ?? { status: 0, body: {} };
    return { status: r.status, body: r.body ?? {} };
  };
  return { client, calls };
}

// --------------------------------------------------------------- Naming --------

test('runnerName is deterministic + RFC1123-safe', () => {
  assert.equal(runnerName('Shop App'), 'app-shop-app');
  assert.equal(runnerName('--x--'), 'app-x');
  assert.ok(runnerName('a'.repeat(80)).length <= 52);
});

// -------------------------------------------------------- What runs is git -----

test('deployApp applies EXACTLY the committed manifests (namespace set, nothing else changed)', async () => {
  const { client, calls } = mockK8s({
    [`GET /api/v1/namespaces/${NS}`]: { status: 200 },
    GET: { status: 404 },
    POST: { status: 201 },
  });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, true, out.detail);
  assert.equal(out.url, `https://${HOST}`);
  const real = calls.find((c) => c.method === 'POST' && c.path === DEP)!;
  const committed = yaml.load(APP.tree.kind === 'tree' ? APP.tree.files.find((f) => f.path === 'k8s/deployment.yaml')!.content : '') as any;
  assert.deepEqual(real.body, { ...committed, metadata: { ...committed.metadata, namespace: NS } });
  assert.match(out.detail, /c0ffee/, 'the outcome names the git sha it deployed');
});

test('deployApp submits a server-side DRY RUN of every object before the real apply', async () => {
  const { client, calls } = mockK8s({ [`GET /api/v1/namespaces/${NS}`]: { status: 200 }, GET: { status: 404 }, POST: { status: 201 } });
  await deployApp(APP, { ...OPTS, k8s: client });
  const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path);
  const firstReal = posts.findIndex((p) => !p.endsWith(DRY));
  const POD = `/api/v1/namespaces/${NS}/pods${DRY}`;
  assert.deepEqual(posts.slice(0, firstReal).sort(), [`${DEP}${DRY}`, `${ING}${DRY}`, `${SVC}${DRY}`, POD].sort());
  const podCheck = calls.find((c) => c.path === POD)!;
  const committed = yaml.load(APP.tree.kind === 'tree' ? APP.tree.files.find((f) => f.path === 'k8s/deployment.yaml')!.content : '') as any;
  assert.deepEqual((podCheck.body as any).spec, committed.spec.template.spec, 'admission judges the committed pod template');
  assert.deepEqual(posts.slice(firstReal).sort(), [DEP, ING, SVC].sort());
});

test('a dry-run rejection (e.g. Pod Security restricted) applies NOTHING and says why', async () => {
  const { client, calls } = mockK8s({
    [`GET /api/v1/namespaces/${NS}`]: { status: 200 },
    GET: { status: 404 },
    [`POST /api/v1/namespaces/${NS}/pods${DRY}`]: { status: 403, body: { message: 'violates PodSecurity "restricted:latest"' } },
    POST: { status: 201 },
  });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(out.url, null);
  assert.match(out.detail, /restricted/);
  assert.equal(calls.filter((c) => c.method === 'POST' && !c.path.endsWith(DRY)).length, 0, 'no real write');
});

test('NEGATIVE TWIN: no k8s/ in git → refused with ZERO Kubernetes calls (no in-memory manifests)', async () => {
  const { client, calls } = mockK8s({ GET: { status: 404 }, POST: { status: 201 } });
  const out = await deployApp(
    { slug: 'shop', host: HOST, tree: { kind: 'tree', files: [{ path: 'Dockerfile', content: 'FROM x' }], sha: 'c0ffee' } },
    { ...OPTS, k8s: client },
  );
  assert.equal(out.ok, false);
  assert.equal(out.phase, 'failed');
  assert.match(out.detail, /k8s\//);
  assert.equal(calls.length, 0);
});

test('an unbuilt image, a foreign registry, or git that cannot answer → refused, zero calls', async () => {
  const forgejo = treeOf(DIGEST);
  if (forgejo.tree.kind === 'tree') {
    forgejo.tree.files = forgejo.tree.files.map((f) =>
      f.path === 'k8s/deployment.yaml' ? { ...f, content: f.content.replace(`${REGISTRY}/shop@${DIGEST}`, 'forgejo-http:3000/gitea_admin/shop:latest') } : f,
    );
  }
  const cases: [RunnerApp, RegExp][] = [
    [treeOf(NOT_BUILT_DIGEST), /not been built/],
    [forgejo, /platform registry/],
    [{ slug: 'shop', host: HOST, tree: { kind: 'failed', reason: 'pack read error' } }, /git.*pack read error/i],
    [{ slug: 'shop', host: HOST, tree: { kind: 'none' } }, /k8s\//],
  ];
  for (const [app, re] of cases) {
    const { client, calls } = mockK8s({ GET: { status: 404 }, POST: { status: 201 } });
    const out = await deployApp(app, { ...OPTS, k8s: client });
    assert.equal(out.ok, false);
    assert.match(out.detail, re);
    assert.equal(calls.length, 0);
  }
});

test('deployApp is idempotent — existing objects are REPLACED (PUT with resourceVersion), reports running', async () => {
  const running = { status: 200, body: { spec: { replicas: 1 }, status: { readyReplicas: 1 }, metadata: { resourceVersion: '7' } } };
  const { client, calls } = mockK8s({
    [`GET /api/v1/namespaces/${NS}`]: { status: 200 },
    [`GET ${DEP}/app-shop`]: running,
    [`GET ${SVC}/app-shop`]: { status: 200, body: { metadata: { resourceVersion: '3' } } },
    [`GET ${ING}/app-shop`]: { status: 200, body: { metadata: { resourceVersion: '5' } } },
    PUT: { status: 200 },
    POST: { status: 201 }, // the pod-template admission dry run
  });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.phase, 'running');
  const put = calls.find((c) => c.method === 'PUT' && c.path === `${DEP}/app-shop`)!;
  assert.equal((put.body as any).metadata.resourceVersion, '7');
});

test('HONESTY: an unreachable API server never claims a live deploy (status 0)', async () => {
  const { client } = mockK8s({ GET: { status: 0 } });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(out.live, false);
  assert.equal(out.url, null);
  assert.equal(out.phase, 'offline');
  assert.match(out.detail, /unreachable/i);
});

test('HONESTY: a cluster rejection on the real apply surfaces as non-ok, no URL', async () => {
  const { client } = mockK8s({
    [`GET /api/v1/namespaces/${NS}`]: { status: 200 },
    GET: { status: 404 },
    [`POST ${DEP}`]: { status: 422 },
    POST: { status: 201 },
  });
  const out = await deployApp(APP, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(out.url, null);
  assert.equal(out.phase, 'failed');
  assert.match(out.detail, /422/);
});

// --------------------------------------------------------------- Status --------

test('runnerStatus maps real Deployment state to a pod-driven phase', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ spec: { replicas: 1 }, status: { readyReplicas: 1 } }, 'running'],
    [{ spec: { replicas: 1 }, status: { readyReplicas: 0 } }, 'deploying'],
    [{ spec: { replicas: 0 }, status: {} }, 'stopped'],
    [
      { spec: { replicas: 1 }, status: { readyReplicas: 0, conditions: [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded' }] } },
      'failed',
    ],
  ];
  for (const [body, phase] of cases) {
    const { client } = mockK8s({ [`GET ${DEP}/app-shop`]: { status: 200, body } });
    const st = await runnerStatus({ slug: 'shop' }, { ...OPTS, k8s: client });
    assert.equal(st.phase, phase, `expected ${phase}`);
    assert.equal(st.live, true);
  }
});

test('runnerStatus: 404 → absent, status 0 → offline (honest)', async () => {
  const absent = await runnerStatus({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ GET: { status: 404 } }).client });
  assert.equal(absent.phase, 'absent');
  const offline = await runnerStatus({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ GET: { status: 0 } }).client });
  assert.equal(offline.phase, 'offline');
  assert.equal(offline.live, false);
});

// ------------------------------------------------------------- Stop / delete ---

test('stopApp scales the Deployment to zero (PATCH /scale)', async () => {
  const { client, calls } = mockK8s({ PATCH: { status: 200 } });
  const out = await stopApp({ slug: 'shop' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'stopped');
  assert.equal(out.phase, 'stopped');
  const patch = calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.path, `${DEP}/app-shop/scale`);
  assert.deepEqual((patch.body as any).spec, { replicas: 0 });
});

test('stopApp: 404 is a benign no-op; status 0 is honest offline', async () => {
  const missing = await stopApp({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ PATCH: { status: 404 } }).client });
  assert.equal(missing.ok, true);
  assert.equal(missing.phase, 'absent');
  const offline = await stopApp({ slug: 'shop' }, { ...OPTS, k8s: mockK8s({ PATCH: { status: 0 } }).client });
  assert.equal(offline.ok, false);
  assert.equal(offline.live, false);
  assert.match(offline.detail, /unreachable/i);
});

test('deleteApp removes Ingress + Service + Deployment (404s benign)', async () => {
  const { client, calls } = mockK8s({
    [`DELETE ${ING}/app-shop`]: { status: 200 },
    [`DELETE ${SVC}/app-shop`]: { status: 200 },
    [`DELETE ${DEP}/app-shop`]: { status: 404 }, // already gone → still ok
  });
  const out = await deleteApp({ slug: 'shop' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'deleted');
  const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  assert.deepEqual(deletes.sort(), [`${DEP}/app-shop`, `${ING}/app-shop`, `${SVC}/app-shop`].sort());
});

test('HONESTY: deleteApp with an unreachable API never claims success', async () => {
  const { client } = mockK8s({ DELETE: { status: 0 } });
  const out = await deleteApp({ slug: 'shop' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(out.live, false);
  assert.match(out.detail, /unreachable/i);
});

// ------------------- WP-51: app-deploy reads `live/app/<id>` from git and records its sha ---

test('WP-51: a deploy records the commit live/app/<id> names in git — and FOLLOWS the tag; no tag is `none`', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { commitTree, mainSha } = await import('@core/infra/git-store');
  const repos = fs.mkdtempSync(path.join(os.tmpdir(), 'wp51-app-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const tag = (sha: string) =>
    execFileSync('git', ['--git-dir', path.join(repos, 'sales.git'), '-c', 'user.name=os', '-c', 'user.email=os@x.invalid', 'tag', '-f', '-a', 'live/app/app_1', sha, '-m', 'go-live app:app_1'], { env });
  const deployed = async () => {
    const { client, calls } = mockK8s({ [`GET /api/v1/namespaces/${NS}`]: { status: 200 }, GET: { status: 404 }, POST: { status: 201 } });
    await deployApp({ ...APP, live: { repo: 'sales', id: 'app_1' } }, { ...OPTS, k8s: client, reposDir: repos });
    return (calls.find((c) => c.method === 'POST' && c.path === DEP)!.body as any).metadata.annotations;
  };
  try {
    await commitTree('sales', new Map([['apps/shop/README.md', 'v1\n']]), { author: { name: 't', email: 't@t.invalid' }, message: 'v1', reposDir: repos });
    const v1 = (await mainSha('sales', { reposDir: repos }))!;
    await commitTree('sales', new Map([['apps/shop/README.md', 'v2\n']]), { author: { name: 't', email: 't@t.invalid' }, message: 'v2', reposDir: repos });
    const v2 = (await mainSha('sales', { reposDir: repos }))!;

    assert.equal((await deployed())['sovereign-os.io/source-sha'], 'none', 'no live tag: said, never guessed');
    tag(v1);
    const a1 = await deployed();
    assert.equal(a1['sovereign-os.io/source-sha'], v1);
    assert.equal(a1['sovereign-os.io/live-tag'], 'live/app/app_1');
    tag(v2); // negative twin: move the tag with PLAIN git — the next deploy records what git says
    assert.equal((await deployed())['sovereign-os.io/source-sha'], v2);
  } finally {
    fs.rmSync(repos, { recursive: true, force: true });
  }
});
