/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    WP-54 eject test — a seeded app builds and serves on a plain cluster with no OS
 * USER STORY: As an engineer I want proof that my app is ordinary code: `docker build` its folder,
 *             push it, `kubectl apply` its k8s/ folder into a Pod Security `restricted` namespace,
 *             and it serves — and that the OS's deploy applies those same files, nothing else.
 * ARCHITECTURE:
 *   - REAL components only: Docker (BuildKit) builds the app's own Dockerfile; a CNCF Distribution
 *     registry stands in for the platform registry; a kind cluster runs Kubernetes with Pod
 *     Security admission. Set up by tests/app-eject/up.sh; skipped unless APP_EJECT_KUBECONFIG is
 *     set (CI: .github/workflows/app-eject.yml).
 *   - The tree is exactly what `createApp` seeds for the `website` template: `lockedSeed` +
 *     `appDeployFiles`, with the digest of the pushed image committed into k8s/deployment.yaml.
 *   - NEGATIVE TWINS (must go red if a hop is faked): no Dockerfile → the build fails (the test
 *     reads the tree, not a cache); a Deployment stripped of its securityContext is refused by the
 *     REAL admission, both for `kubectl apply` and for the OS deploy (its dry run), and nothing is
 *     created.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { websiteFiles } from './scaffolds/website.ts';
import { lockedSeed } from './scaffold-lock.ts';
import { appDeployFiles } from './native-deploy.ts';
import { deployApp, runnerStatus, type RunnerK8s } from './runner.ts';

const KUBECONFIG = process.env.APP_EJECT_KUBECONFIG ?? '';
const REG_PORT = process.env.APP_EJECT_REGISTRY_PORT ?? '5001';
const REGISTRY = `localhost:${REG_PORT}/sovereign-os-apps`;
const SLUG = 'eject-site';
const HOST = 'eject-site.eject.apps.test';
const skip = KUBECONFIG ? false : 'APP_EJECT_KUBECONFIG not set (run tests/app-eject/up.sh)';
const OS_UI = 'system:serviceaccount:agentic-os:os-ui';
const POLICY = join(import.meta.dirname, '..', '..', '..', '..', 'charts', 'sovereign-agentic-os', 'files', 'apps-admission-policy.yaml');

/** The chart's runner Role (templates/base/os-ui/apps-runner.yaml) for the os-ui identity in `ns`. */
function bindOsUi(ns: string) {
  kubectl(['-n', ns, 'create', 'role', 'os-ui-apps-runner', '--verb=create,get,list,watch,update,patch,delete', '--resource=deployments.apps,deployments.apps/scale,services,ingresses.networking.k8s.io']);
  kubectl(['-n', ns, 'create', 'role', 'os-ui-apps-pods', '--verb=get,list,watch,create', '--resource=pods']);
  for (const r of ['os-ui-apps-runner', 'os-ui-apps-pods']) kubectl(['-n', ns, 'create', 'rolebinding', r, `--role=${r}`, '--serviceaccount=agentic-os:os-ui']);
}
const asOsUi = (args: string[], input?: string) => kubectl([`--as=${OS_UI}`, ...args], input);

const kubectl = (args: string[], input?: string) =>
  execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

function writeTree(dir: string, files: { path: string; content: string }[]) {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
}

function restrictedNamespace(ns: string) {
  kubectl(['create', 'namespace', ns]);
  kubectl(['label', 'namespace', ns, 'pod-security.kubernetes.io/enforce=restricted', 'pod-security.kubernetes.io/enforce-version=latest']);
}

/** Strip the pod/container hardening so `restricted` must refuse it. */
function insecure(files: { path: string; content: string }[]) {
  return files.map((f) => {
    if (f.path !== 'k8s/deployment.yaml') return f;
    const d = yaml.load(f.content) as any;
    delete d.spec.template.spec.securityContext;
    delete d.spec.template.spec.containers[0].securityContext;
    return { path: f.path, content: yaml.dump(d) };
  });
}

let work = '';
let image = '';
let deployFiles: { path: string; content: string }[] = [];
let seed: { path: string; content: string }[] = [];

test('BUILD: docker build of the seeded app folder, pushed to the registry, pinned by digest', { skip, timeout: 600_000 }, () => {
  work = mkdtempSync(join(tmpdir(), 'wp54-eject-'));
  seed = lockedSeed('website', websiteFiles('Eject Site', SLUG), SLUG);
  writeTree(work, seed);

  // NEGATIVE TWIN: the same build with the Dockerfile removed must fail.
  const noDocker = mkdtempSync(join(tmpdir(), 'wp54-nodocker-'));
  writeTree(noDocker, seed.filter((f) => f.path !== 'Dockerfile'));
  assert.throws(() => execFileSync('docker', ['build', '-q', noDocker], { stdio: 'pipe' }), 'no Dockerfile → no image');
  rmSync(noDocker, { recursive: true, force: true });

  const tag = `${REGISTRY}/${SLUG}:eject`;
  execFileSync('docker', ['build', '-t', tag, work], { stdio: 'inherit' });
  execFileSync('docker', ['push', tag], { stdio: 'inherit' });
  image = execFileSync('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', tag], { encoding: 'utf8' }).trim();
  assert.match(image, new RegExp(`^${REGISTRY}/${SLUG}@sha256:[a-f0-9]{64}$`));
  deployFiles = appDeployFiles({ slug: SLUG, host: HOST, registry: REGISTRY, digest: image.split('@')[1] });
  writeTree(work, deployFiles);
});

test('EJECT: kubectl apply -f k8s/ into a restricted namespace with no OS present → the app serves', { skip, timeout: 300_000 }, async () => {
  restrictedNamespace('eject');
  kubectl(['apply', '-n', 'eject', '-f', join(work, 'k8s')]);
  kubectl(['-n', 'eject', 'rollout', 'status', `deployment/app-${SLUG}`, '--timeout=240s']);
  const body = await viaPortForward('eject', `app-${SLUG}`);
  assert.match(body, /<div id="root">/, 'the built Vite site is served');

  // NEGATIVE TWIN: the same manifests without the hardening: Pod Security admission refuses the
  // ReplicaSet's pods (admission judges Pods, not Deployments), so the app never serves.
  restrictedNamespace('eject-neg');
  const bad = mkdtempSync(join(tmpdir(), 'wp54-bad-'));
  writeTree(bad, insecure(deployFiles));
  kubectl(['apply', '-n', 'eject-neg', '-f', join(bad, 'k8s')]);
  rmSync(bad, { recursive: true, force: true });
  let events = '';
  for (let i = 0; i < 30 && !/violates PodSecurity/.test(events); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    events = kubectl(['-n', 'eject-neg', 'get', 'events', '-o', 'custom-columns=MSG:.message', '--no-headers']);
  }
  assert.match(events, /violates PodSecurity "restricted/, 'the real admission refused the pods');
  assert.equal(JSON.parse(kubectl(['-n', 'eject-neg', 'get', 'pods', '-o', 'json'])).items.length, 0, 'no pod exists');
});

test('OS DEPLOY: deployApp applies the same committed files through the API (dry run first) → running', { skip, timeout: 300_000 }, async () => {
  // The chart's admission policies, bound to os-apps, and the runner's RBAC for the os-ui identity.
  restrictedNamespace('os-apps');
  restrictedNamespace('os-neg');
  bindOsUi('os-apps');
  bindOsUi('os-neg');
  kubectl(['apply', '-f', '-'], readFileSync(POLICY, 'utf8').replaceAll('__APPS_NAMESPACE__', 'os-apps').replaceAll('__OS_UI_USER__', OS_UI));
  await new Promise((r) => setTimeout(r, 3000)); // policy compilation
  // The OS talks to the API AS os-ui (impersonated), exactly as in production.
  const proxy = spawn('kubectl', ['--kubeconfig', KUBECONFIG, `--as=${OS_UI}`, 'proxy', '--port=18054'], { stdio: 'pipe' });
  try {
    await waitFor(proxy, /Starting to serve/);
    const k8s: RunnerK8s = async (method, path, body) => {
      try {
        const res = await fetch(`http://127.0.0.1:18054${path}`, {
          method,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
      } catch {
        return { status: 0, body: {} };
      }
    };
    const tree = { kind: 'tree' as const, files: [...seed, ...deployFiles], sha: 'eject' };
    const out = await deployApp({ slug: SLUG, host: HOST, tree }, { k8s, namespace: 'os-apps', registry: REGISTRY });
    assert.equal(out.ok, true, out.detail);
    let phase = out.phase;
    for (let i = 0; i < 60 && phase !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      phase = (await runnerStatus({ slug: SLUG }, { k8s, namespace: 'os-apps' })).phase;
    }
    assert.equal(phase, 'running');
    const live = JSON.parse(kubectl(['-n', 'os-apps', 'get', 'deployment', `app-${SLUG}`, '-o', 'json']));
    assert.equal(live.spec.template.spec.containers[0].image, image, 'the cluster runs the committed digest');
    assert.equal(await viaPortForward('os-apps', `app-${SLUG}`).then((b) => /<div id="root">/.test(b)), true);

    // ADMISSION POLICY: as os-ui, the hostile objects the OS gate refuses are refused by Kubernetes too.
    const externalName = yaml.dump({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'probe-ext' }, spec: { type: 'ExternalName', externalName: 'opa.agentic-os.svc.cluster.local' } });
    assert.throws(() => asOsUi(['-n', 'os-apps', 'create', '-f', '-'], externalName), /ClusterIP/);
    const authUrl = yaml.dump({
      apiVersion: 'networking.k8s.io/v1', kind: 'Ingress',
      metadata: { name: 'probe-ing', annotations: { 'nginx.ingress.kubernetes.io/auth-url': 'http://x' } },
      spec: { rules: [{ host: HOST, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'probe-ing', port: { number: 80 } } } }] } }] },
    });
    assert.throws(() => asOsUi(['-n', 'os-apps', 'create', '-f', '-'], authUrl), /annotation/);
    const realPod = yaml.dump({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'probe-pod' }, spec: (JSON.parse(kubectl(['-n', 'os-apps', 'get', 'deployment', `app-${SLUG}`, '-o', 'json'])).spec.template.spec) });
    assert.throws(() => asOsUi(['-n', 'os-apps', 'create', '-f', '-'], realPod), /dry run/);
    assert.doesNotThrow(() => asOsUi(['-n', 'os-apps', 'create', '--dry-run=server', '-f', '-'], realPod), 'the dry-run Pod is allowed');
    // NEGATIVE TWIN: the same ExternalName as cluster-admin is admitted — the POLICY refused it above.
    assert.doesNotThrow(() => kubectl(['-n', 'os-apps', 'create', '-f', '-'], externalName));
    kubectl(['-n', 'os-apps', 'delete', 'service', 'probe-ext']);

    // NEGATIVE TWIN: the insecure tree is refused in the dry run by the real admission; nothing exists.
    const neg = await deployApp(
      { slug: SLUG, host: HOST, tree: { kind: 'tree', files: [...seed, ...insecure(deployFiles)], sha: 'neg' } },
      { k8s, namespace: 'os-neg', registry: REGISTRY },
    );
    assert.equal(neg.ok, false);
    assert.match(neg.detail, /dry run.*PodSecurity/i);
    assert.match(kubectl(['-n', 'os-neg', 'get', 'deployment,service,ingress', '-o', 'name']), /^\s*$/, 'nothing was created');
  } finally {
    proxy.kill();
    if (work) rmSync(work, { recursive: true, force: true });
  }
});

function waitFor(p: ChildProcess, re: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}`)), 30_000);
    const on = (b: Buffer) => { if (re.test(b.toString())) { clearTimeout(t); resolve(); } };
    p.stdout?.on('data', on);
    p.stderr?.on('data', on);
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`exited ${c}`)); });
  });
}

async function viaPortForward(ns: string, svc: string): Promise<string> {
  const port = ns === 'eject' ? 18081 : 18082;
  const pf = spawn('kubectl', ['--kubeconfig', KUBECONFIG, '-n', ns, 'port-forward', `svc/${svc}`, `${port}:80`], { stdio: 'pipe' });
  try {
    await waitFor(pf, /Forwarding from/);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    return await res.text();
  } finally {
    pf.kill();
  }
}
