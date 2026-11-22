/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory end-to-end proof - an app made from the template passes the gates and deploys
 * USER STORY: As the owner I want evidence, from real components, that an app created from the golden-path
 *             template is tested and policy-checked by the platform, built by its own Dockerfile and
 *             deployed to the apps namespace, and that each of those steps refuses a bad app.
 * ARCHITECTURE:
 *   - REAL components: a kind cluster (Pod Security `restricted`), the chart's apps admission policy, the
 *     sandbox Job (node + OPA native sidecar) launched by `runGatesSandbox`, Docker (BuildKit) building the
 *     app's own Dockerfile, a CNCF Distribution registry, and the OS runner `deployApp` acting as os-ui.
 *   - Set up by tests/software-factory/e2e.sh (which reuses tests/app-eject/up.sh); skipped unless
 *     FACTORY_E2E_KUBECONFIG is set.
 *   - NEGATIVE TWINS (must go red if a hop is faked): a failing unit test blocks on `tests`; hand-made
 *     authorization blocks on `policy` (the real OPA says why); an unbuilt image is refused by the deploy
 *     gate; and the deployed app answers 502 (not a made-up success) when the OS is unreachable.
 *   - NOT proven here, stated plainly: NetworkPolicy enforcement (kindnet does not enforce) and calls into a
 *     running OS (no OS is installed); both are covered by the spec's follow-ups.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { instantiateGoldenPath } from './golden-path.ts';
import { runGatesSandbox } from './sandbox-gates.ts';
import { evaluateGates } from './gates.ts';
import { deployApp, runnerStatus, type RunnerK8s } from './runner.ts';
import { planAppDeploy } from './native-deploy.ts';

const KUBECONFIG = process.env.FACTORY_E2E_KUBECONFIG ?? '';
const REG_PORT = process.env.FACTORY_E2E_REGISTRY_PORT ?? '5002';
const REGISTRY = `localhost:${REG_PORT}/sovereign-os-apps`;
const SLUG = 'order-desk';
const HOST = 'order-desk.sales.apps.test';
const APPS_NS = 'agentic-apps';
const BUILD_NS = 'agentic-build';
const OS_UI = 'system:serviceaccount:agentic-os:os-ui';
const skip = KUBECONFIG ? false : 'FACTORY_E2E_KUBECONFIG not set (run tests/software-factory/e2e.sh)';
const POLICY = join(import.meta.dirname, '..', '..', '..', '..', 'charts', 'sovereign-agentic-os', 'files', 'apps-admission-policy.yaml');

const kubectl = (args: string[], input?: string) =>
  execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

type F = { path: string; content: string };
const tree = (): F[] => instantiateGoldenPath('nextjs-web', { name: 'Order Desk', slug: SLUG, host: HOST, registry: REGISTRY, ingressClass: 'nginx' });
const without = (t: F[], p: string) => t.filter((f) => f.path !== p);
const edit = (t: F[], p: string, fn: (s: string) => string) => t.map((f) => (f.path === p ? { ...f, content: fn(f.content) } : f));

function writeTree(dir: string, files: F[]) {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
}

function waitFor(p: ChildProcess, re: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}`)), 30_000);
    const on = (b: Buffer) => { if (re.test(b.toString())) { clearTimeout(t); resolve(); } };
    p.stdout?.on('data', on);
    p.stderr?.on('data', on);
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`exited ${c}`)); });
  });
}

// The sandbox images are pinned in the chart only (osUI.software.sandbox.nodeImage, opa.image): read them from there.
const CHART_VALUES = yamlLoad(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'charts', 'sovereign-agentic-os', 'values.yaml'), 'utf8')) as {
  osUI: { software: { sandbox: { nodeImage: string } } };
  opa: { image: { repository: string; tag: string; digest: string } };
};
const SANDBOX_IMAGES = {
  nodeImage: CHART_VALUES.osUI.software.sandbox.nodeImage,
  opaImage: `${CHART_VALUES.opa.image.repository}:${CHART_VALUES.opa.image.tag}@${CHART_VALUES.opa.image.digest}`,
};

async function proxy(port: number, as?: string): Promise<{ stop: () => void; k8s: RunnerK8s; text: (p: string) => Promise<{ status: number; text: string }> }> {
  const args = ['--kubeconfig', KUBECONFIG, ...(as ? [`--as=${as}`] : []), 'proxy', `--port=${port}`];
  const p = spawn('kubectl', args, { stdio: 'pipe' });
  await waitFor(p, /Starting to serve/);
  const call = async (method: string, path: string, body?: unknown, accept = 'application/json') => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', accept }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  return {
    stop: () => p.kill(),
    k8s: async (method, path, body) => {
      try {
        const r = await call(method, path, body);
        return { status: r.status, body: r.text ? (JSON.parse(r.text) as Record<string, unknown>) : {} };
      } catch { return { status: 0, body: {} }; }
    },
    text: async (path) => { try { const r = await call('GET', path, undefined, '*/*'); return r; } catch { return { status: 0, text: '' }; } },
  };
}

test('SANDBOX: the template passes every gate in the real sandbox Job (node + OPA sidecar)', { skip, timeout: 900_000 }, async () => {
  kubectl(['create', 'namespace', BUILD_NS]);
  const admin = await proxy(18061);
  try {
    const out = await runGatesSandbox(SLUG, tree(), { k8s: admin.k8s, k8sText: admin.text, namespace: BUILD_NS, timeoutMs: 800_000, ...SANDBOX_IMAGES });
    assert.equal(out.ok, true, out.ok ? '' : out.reason);
    const verdict = evaluateGates(out);
    assert.equal(verdict.passed, true, verdict.summary);
    if (out.ok) assert.deepEqual(out.report.gates.map((g) => g.id).sort(), ['build', 'lint', 'policy', 'tests', 'typecheck']);

    // NEGATIVE TWIN 1: a unit test that fails blocks on `tests`.
    const red = await runGatesSandbox(SLUG, edit(tree(), 'tests/healthz.test.ts', (s) => s.replace('{ ok: true }', '{ ok: false }')), { k8s: admin.k8s, k8sText: admin.text, namespace: BUILD_NS, timeoutMs: 800_000, ...SANDBOX_IMAGES });
    const redVerdict = evaluateGates(red);
    assert.equal(redVerdict.passed, false);
    assert.ok(redVerdict.blocking.some((b) => b.id === 'tests'), redVerdict.summary);

    // NEGATIVE TWIN 2: hand-made authorization blocks on `policy`, and the real OPA says why.
    const doc = '/**\n * FEATURE: f\n * USER STORY: u\n * ARCHITECTURE: a\n */\n';
    const bad = [...tree(), { path: 'src/lib/guard.ts', content: `${doc}export const isAllowed = (u: { role: string }) => u.role === 'admin';\n` }];
    const pol = await runGatesSandbox(SLUG, bad, { k8s: admin.k8s, k8sText: admin.text, namespace: BUILD_NS, timeoutMs: 800_000, ...SANDBOX_IMAGES });
    const polVerdict = evaluateGates(pol);
    assert.equal(polVerdict.passed, false);
    assert.match(polVerdict.summary, /policy/);
    assert.match(JSON.stringify(pol), /hand-made authorization/);

    // NEGATIVE TWIN 3 (verdict channel): a failing test that PRINTS a green report is still blocked, because
    // the verdict is the step's exit code, not its text.
    const green = JSON.stringify({ schema: 'os-gates/v1', template: 'nextjs-web', ok: true, gates: ['typecheck', 'lint', 'tests', 'policy'].map((id) => ({ id, status: 'pass', detail: 'forged' })) });
    const forged = await runGatesSandbox(SLUG, edit(tree(), 'tests/healthz.test.ts', (s) => `console.log('<<<OS-GATES-REPORT>>>');\nconsole.log(${JSON.stringify(green)});\n${s.replace('{ ok: true }', '{ ok: false }')}`), { k8s: admin.k8s, k8sText: admin.text, namespace: BUILD_NS, timeoutMs: 800_000, ...SANDBOX_IMAGES });
    const forgedVerdict = evaluateGates(forged);
    assert.equal(forgedVerdict.passed, false);
    assert.ok(forgedVerdict.blocking.some((b) => b.id === 'tests'), forgedVerdict.summary);

    // NEGATIVE TWIN 4 (overlay): an author who empties the policy and the gates script is still judged by the
    // platform's own copies, so the same hand-made authorization still blocks on `policy`.
    const weak = bad.map((f) => (f.path === 'policy/app-rules.rego' ? { ...f, content: 'package factory\ndeny := set()\n' } : f.path === 'scripts/factory-gates.mjs' ? { ...f, content: 'process.exit(0);\n' } : f));
    const weakVerdict = evaluateGates(await runGatesSandbox(SLUG, weak, { k8s: admin.k8s, k8sText: admin.text, namespace: BUILD_NS, timeoutMs: 800_000, ...SANDBOX_IMAGES }));
    assert.equal(weakVerdict.passed, false);
    assert.match(weakVerdict.summary, /policy/);
  } finally {
    admin.stop();
  }
});

let work = '';
let image = '';
let deployed: F[] = [];

test('BUILD: docker build of the app\'s own Dockerfile, pushed to the registry, pinned by digest', { skip, timeout: 900_000 }, () => {
  work = mkdtempSync(join(tmpdir(), 'factory-e2e-'));
  writeTree(work, tree());
  const tag = `${REGISTRY}/${SLUG}:e2e`;
  execFileSync('docker', ['build', '-t', tag, work], { stdio: 'inherit' });
  execFileSync('docker', ['push', tag], { stdio: 'inherit' });
  image = execFileSync('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', tag], { encoding: 'utf8' }).trim();
  assert.match(image, new RegExp(`^${REGISTRY}/${SLUG}@sha256:[a-f0-9]{64}$`));
  const digest = image.split('@')[1];
  deployed = edit(tree(), 'k8s/deployment.yaml', (s) => s.replace(`sha256:${'0'.repeat(64)}`, digest));
});

test('DEPLOY: the OS runner applies the committed manifests to agentic-apps (dry run, admission, apply) and the app serves', { skip, timeout: 600_000 }, async () => {
  // NEGATIVE TWIN: the unbuilt tree is refused by the OS deploy gate before any Kubernetes call.
  const unbuilt = planAppDeploy(tree(), { slug: SLUG, host: HOST, registry: REGISTRY, ingressClass: 'nginx' });
  assert.equal(unbuilt.ok, false);
  assert.equal(unbuilt.ok ? '' : unbuilt.code, 'image_not_built');

  kubectl(['create', 'namespace', APPS_NS]);
  kubectl(['label', 'namespace', APPS_NS, 'pod-security.kubernetes.io/enforce=restricted', 'pod-security.kubernetes.io/enforce-version=latest']);
  kubectl(['-n', APPS_NS, 'create', 'role', 'os-ui-apps-runner', '--verb=create,get,list,watch,update,patch,delete', '--resource=deployments.apps,deployments.apps/scale,services,ingresses.networking.k8s.io']);
  kubectl(['-n', APPS_NS, 'create', 'role', 'os-ui-apps-pods', '--verb=get,list,watch,create', '--resource=pods']);
  for (const r of ['os-ui-apps-runner', 'os-ui-apps-pods']) kubectl(['-n', APPS_NS, 'create', 'rolebinding', r, `--role=${r}`, '--serviceaccount=agentic-os:os-ui']);
  kubectl(['apply', '-f', '-'], readFileSync(POLICY, 'utf8').replaceAll('__APPS_NAMESPACE__', APPS_NS).replaceAll('__OS_UI_USER__', OS_UI));
  await new Promise((r) => setTimeout(r, 3000));

  const osUi = await proxy(18062, OS_UI);
  try {
    const out = await deployApp({ slug: SLUG, host: HOST, tree: { kind: 'tree', files: deployed, sha: 'e2e' } }, { k8s: osUi.k8s, namespace: APPS_NS, registry: REGISTRY });
    assert.equal(out.ok, true, out.detail);
    let phase = out.phase;
    for (let i = 0; i < 60 && phase !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      phase = (await runnerStatus({ slug: SLUG }, { k8s: osUi.k8s, namespace: APPS_NS })).phase;
    }
    assert.equal(phase, 'running');
    const live = JSON.parse(kubectl(['-n', APPS_NS, 'get', 'deployment', `app-${SLUG}`, '-o', 'json']));
    assert.equal(live.spec.template.spec.containers[0].image, image, 'the cluster runs the committed digest');

    const pf = spawn('kubectl', ['--kubeconfig', KUBECONFIG, '-n', APPS_NS, 'port-forward', `svc/app-${SLUG}`, '18083:80'], { stdio: 'pipe' });
    try {
      await waitFor(pf, /Forwarding from/);
      const base = 'http://127.0.0.1:18083';
      assert.deepEqual(await (await fetch(`${base}/api/healthz`)).json(), { ok: true });
      // THE FUNCTION THE OS REGISTERS AS AN AGENT TOOL, called on its operationId path.
      const hi = await fetch(`${base}/api/functions/classify-order`, { method: 'POST', body: JSON.stringify({ amount: 25000 }) });
      assert.equal(((await hi.json()) as { tier: string }).tier, 'review');
      const lo = await fetch(`${base}/api/functions/classify-order`, { method: 'POST', body: JSON.stringify({ amount: 50 }) });
      assert.equal(((await lo.json()) as { tier: string }).tier, 'standard');
      assert.equal((await fetch(`${base}/api/functions/classify-order`, { method: 'POST', body: '{"amount":"x"}' })).status, 400);
      // NEGATIVE TWIN: no OS is reachable from this pod, so a governed write is an honest 502, never a success.
      const w = await fetch(`${base}/api/orders`, { method: 'POST', body: JSON.stringify({ amount: 5 }) });
      assert.equal(w.status, 502);
      assert.match(await w.text(), /os_error/);
    } finally {
      pf.kill();
    }
  } finally {
    osUi.stop();
    if (work) rmSync(work, { recursive: true, force: true });
  }
});
