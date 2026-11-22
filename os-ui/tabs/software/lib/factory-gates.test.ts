/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - quality gates run in a sandbox and block a deploy until they pass
 * USER STORY: As a builder approving a deploy I want proof that the app's tests, type check, lint and
 *             policy rules passed on the exact tree that will ship - and a refusal, not a warning,
 *             when they did not or could not run.
 * ARCHITECTURE: Pure verdict logic (gates.ts), the sandbox Job (sandbox-gates.ts, run here against a
 *             scripted Kubernetes API), the wiring into requestDeploy, and the app's Rego policy
 *             evaluated by the REAL OPA (docker image or local binary; skipped with a reason if neither
 *             exists). The real-cluster proof is tests/software-factory/e2e.sh.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config as cfg } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { createApp } from '@tabs/software/lib/apps';
import { requestDeploy, __resetReviewCards } from './review.ts';
import { instantiateGoldenPath } from './golden-path.ts';
import { REQUIRED_GATES, evaluateGates, parseGatesLog, GATES_REPORT_DELIM, type GatesOutcome } from './gates.ts';
import { buildGatesJobManifest, runGatesSandbox } from './sandbox-gates.ts';

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-t-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  rmSync(reposDir, { recursive: true, force: true });
});

const green = (over: Record<string, string> = {}): GatesOutcome => ({
  ok: true,
  report: {
    schema: 'os-gates/v1',
    template: 'nextjs-web',
    ok: true,
    gates: REQUIRED_GATES.map((id) => ({ id, status: (over[id] ?? 'pass') as 'pass', detail: 'x' })),
  },
});

// ------------------------------------------------------------------ verdict ---

test('all required gates passing is a pass', () => {
  assert.deepEqual(evaluateGates(green()).blocking, []);
  assert.equal(evaluateGates(green()).passed, true);
});

test('a failing gate blocks and names itself and its detail', () => {
  const v = evaluateGates(green({ tests: 'fail' }));
  assert.equal(v.passed, false);
  assert.deepEqual(v.blocking.map((b) => b.id), ['tests']);
});

test('an unavailable gate is NOT a pass', () => {
  const v = evaluateGates(green({ policy: 'unavailable' }));
  assert.equal(v.passed, false);
  assert.match(v.blocking[0].detail, /unavailable|did not run/i);
});

test('a report that omits a required gate cannot pass (a script that skips checks is not green)', () => {
  const o = green();
  if (o.ok) o.report.gates = o.report.gates.filter((g) => g.id !== 'lint');
  const v = evaluateGates(o);
  assert.equal(v.passed, false);
  assert.ok(v.blocking.some((b) => b.id === 'lint'));
});

test('a report that says ok:true while a gate failed is still blocked (the verdict is recomputed)', () => {
  const o = green({ typecheck: 'fail' });
  assert.equal(o.ok && o.report.ok, true);
  assert.equal(evaluateGates(o).passed, false);
});

test('a sandbox that could not run is a block with its reason', () => {
  const v = evaluateGates({ ok: false, kind: 'no-cluster', reason: 'no cluster' });
  assert.equal(v.passed, false);
  assert.match(v.blocking[0].detail, /no cluster/);
});

test('the pod log is read from the frame, not the noise around it', () => {
  const report = JSON.stringify(green().ok ? (green() as { report: unknown }).report : {});
  const parsed = parseGatesLog(`npm WARN deprecated x\n${GATES_REPORT_DELIM}\n${report}\n`);
  assert.equal(parsed.ok, true);
  const none = parseGatesLog('npm ERR! something\n');
  assert.equal(none.ok, false);
});

// --------------------------------------------------------------- the sandbox ---

test('the sandbox Job is restricted: no token, non-root, read-only root, limits, secret payload, OPA as a native sidecar', () => {
  const job = buildGatesJobManifest({ name: 'gates-x', namespace: 'agentic-build', nodeImage: 'node:22', opaImage: 'opa:1', timeoutMs: 600_000 }) as {
    spec: { activeDeadlineSeconds: number; template: { spec: Record<string, unknown> } };
  };
  const pod = job.spec.template.spec as { automountServiceAccountToken: boolean; securityContext: { runAsNonRoot: boolean }; initContainers: { name: string; restartPolicy?: string }[]; containers: { name: string; securityContext: { readOnlyRootFilesystem: boolean; allowPrivilegeEscalation: boolean }; resources: { limits: { memory: string } }; env: { name: string; value: string }[] }[]; volumes: { name: string; secret?: unknown }[] };
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(job.spec.activeDeadlineSeconds, 600);
  assert.deepEqual(pod.initContainers.map((c) => c.name), ['writer', 'opa']);
  assert.equal(pod.initContainers[1].restartPolicy, 'Always');
  const main = pod.containers[0];
  assert.equal(main.name, 'gates');
  assert.equal(main.securityContext.readOnlyRootFilesystem, true);
  assert.equal(main.securityContext.allowPrivilegeEscalation, false);
  assert.ok(main.resources.limits.memory);
  assert.ok(main.env.some((e) => e.name === 'OPA_URL' && e.value === 'http://127.0.0.1:8181'));
  assert.ok(pod.volumes.some((v) => v.name === 'payload' && v.secret));
});

type Call = { method: string; path: string; body?: unknown };
function scriptedK8s(logText: string, opts: { jobFails?: boolean } = {}) {
  const calls: Call[] = [];
  const k8s = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === 'DELETE') return { status: 404, body: {} };
    if (method === 'POST' && path.endsWith('/jobs')) return { status: 201, body: { metadata: { uid: 'job-uid' } } };
    if (method === 'POST') return { status: 201, body: {} };
    if (path.includes('/pods?')) return { status: 200, body: { items: [{ metadata: { name: 'p1', ownerReferences: [{ uid: 'job-uid' }] } }] } };
    if (path.includes('/jobs/')) return { status: 200, body: { status: opts.jobFails ? { failed: 1, conditions: [{ type: 'Failed', reason: 'BackoffLimitExceeded' }] } : { succeeded: 1 } } };
    return { status: 404, body: {} };
  };
  const k8sText = async (path: string) => { calls.push({ method: 'LOG', path }); return { status: 200, text: logText }; };
  return { calls, k8s, k8sText };
}
const files = () => instantiateGoldenPath('nextjs-web', { name: 'A', slug: 'a', host: 'a.d.apps.test', registry: 'r/apps', ingressClass: 'nginx' });

test('a green pod log becomes a passing outcome, read from the gates container, and the payload Secret is dropped', async () => {
  const s = scriptedK8s(`noise\n${GATES_REPORT_DELIM}\n${JSON.stringify((green() as { report: unknown }).report)}\n`);
  const out = await runGatesSandbox('a', files(), { k8s: s.k8s, k8sText: s.k8sText, namespace: 'agentic-build', runId: 't1', sleep: async () => {} });
  assert.equal(out.ok, true);
  assert.equal(evaluateGates(out).passed, true);
  assert.ok(s.calls.some((c) => c.method === 'LOG' && c.path.includes('container=gates')));
  assert.ok(s.calls.some((c) => c.method === 'DELETE' && c.path.includes('/secrets/')));
});

test('a failed Job is a refusal, never a pass', async () => {
  const s = scriptedK8s('', { jobFails: true });
  const out = await runGatesSandbox('a', files(), { k8s: s.k8s, k8sText: s.k8sText, namespace: 'agentic-build', runId: 't2', sleep: async () => {} });
  assert.equal(out.ok, false);
  assert.equal(evaluateGates(out).passed, false);
});

test('no Kubernetes API at all is a refusal naming the cause', async () => {
  const out = await runGatesSandbox('a', files(), { k8s: async () => ({ status: 0, body: {} }), k8sText: async () => ({ status: 0, text: '' }), namespace: 'x', runId: 't3', sleep: async () => {} });
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.kind, 'no-cluster');
});

// ----------------------------------------------- the deploy request is blocked ---

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };

test('requestDeploy on a golden-path app is refused (422) while a gate fails, and opens the review once all pass', async () => {
  __resetReviewCards();
  const app = await createApp(creator, { name: 'Gate Desk', template: 'nextjs-web' });
  await assert.rejects(
    requestDeploy(app.id, creator, { scanMode: 'offline-mock', gates: async () => green({ tests: 'fail' }) }),
    (e: Error & { status?: number }) => { assert.equal(e.status, 422); assert.match(e.message, /tests/); return true; },
  );
  const ok = await requestDeploy(app.id, creator, { scanMode: 'offline-mock', gates: async () => green() });
  assert.equal(ok.kind, 'review');
});

// ------------------------------------------------- the policy, in the real OPA ---

const OPA_IMAGE = process.env.GOLDEN_PATH_OPA_IMAGE ?? 'openpolicyagent/opa:1.22.4';
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const opaBin = process.env.OPA_BIN ?? (spawnSync('opa', ['version'], { stdio: 'ignore' }).status === 0 ? 'opa' : '');
const skipOpa = opaBin || dockerOk ? false : 'neither an opa binary nor a docker daemon is available';

function denyFor(tree: { path: string; content: string }[]): string[] {
  const dir = mkdtempSync(join(homedir(), '.cache-golden-path-opa-'));
  try {
    const facts = { files: tree.filter((f) => !f.path.startsWith('vendor/') && /\.(ts|tsx|mjs|js|json|yaml|yml|md|rego)$|Dockerfile|\.env/.test(f.path)) };
    mkdirSync(join(dir, 'policy'), { recursive: true });
    writeFileSync(join(dir, 'policy', 'app-rules.rego'), tree.find((f) => f.path === 'policy/app-rules.rego')!.content);
    writeFileSync(join(dir, 'input.json'), JSON.stringify(facts));
    const args = ['eval', '--format', 'json'];
    const out = opaBin
      ? execFileSync(opaBin, [...args, '-d', join(dir, 'policy'), '-i', join(dir, 'input.json'), 'data.factory.deny'], { encoding: 'utf8' })
      : execFileSync('docker', ['run', '--rm', '-v', `${dir}:/w:ro`, OPA_IMAGE, ...args, '-d', '/w/policy', '-i', '/w/input.json', 'data.factory.deny'], { encoding: 'utf8' });
    return (JSON.parse(out).result?.[0]?.expressions?.[0]?.value ?? []) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const mutate = (t: { path: string; content: string }[], path: string, fn: (s: string) => string) => t.map((f) => (f.path === path ? { ...f, content: fn(f.content) } : f));
const add = (t: { path: string; content: string }[], path: string, content: string) => [...t, { path, content }];
const DOC = '/**\n * FEATURE: f\n * USER STORY: u\n * ARCHITECTURE: a\n */\n';

test('REAL OPA: the untouched template violates no rule', { skip: skipOpa }, () => {
  assert.deepEqual(denyFor(files()), []);
});

test('REAL OPA: hand-made authorization outside src/lib/os is denied', { skip: skipOpa }, () => {
  const t = add(files(), 'src/lib/guard.ts', `${DOC}export const isAllowed = (user: { role: string }) => user.role === 'admin';\n`);
  assert.ok(denyFor(t).some((m) => /hand-made authorization/.test(m)));
});

test('REAL OPA: a direct datastore client is denied', { skip: skipOpa }, () => {
  const t = add(files(), 'src/lib/db.ts', `${DOC}import { Client } from 'pg';\nexport const c = new Client();\n`);
  assert.ok(denyFor(t).some((m) => /direct datastore/.test(m)));
});

test('REAL OPA: a fetch to an absolute URL is denied', { skip: skipOpa }, () => {
  const t = add(files(), 'src/lib/leak.ts', `${DOC}export const go = () => fetch('https://example.com/x');\n`);
  assert.ok(denyFor(t).some((m) => /absolute URL/.test(m)));
});

test('REAL OPA: a hard-coded secret and a committed .env are denied', { skip: skipOpa }, () => {
  const a = add(files(), 'src/lib/k.ts', `${DOC}export const apiKey = 'abcdef1234567890abcd';\n`);
  assert.ok(denyFor(a).some((m) => /hard-coded secret/.test(m)));
  assert.ok(denyFor(add(files(), '.env', 'X=1\n')).some((m) => /environment files/.test(m)));
});

test('REAL OPA: missing docs, a source file without a doc block, an untested route and an undeclared route are denied', { skip: skipOpa }, () => {
  assert.ok(denyFor(files().filter((f) => f.path !== 'AGENTS.md')).some((m) => /AGENTS\.md is missing/.test(m)));
  assert.ok(denyFor(add(files(), 'src/lib/nodoc.ts', 'export const a = 1;\n')).some((m) => /no doc block/.test(m)));
  const route = add(files(), 'src/app/api/extra/route.ts', `${DOC}export const GET = () => Response.json({});\n`);
  const msgs = denyFor(route);
  assert.ok(msgs.some((m) => /no test imports this route/.test(m)));
  assert.ok(msgs.some((m) => /not declared in openapi\.yaml/.test(m)));
});
