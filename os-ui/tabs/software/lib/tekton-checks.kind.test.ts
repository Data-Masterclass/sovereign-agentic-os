/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory CI end-to-end proof - a real git push runs the app's own Tekton pipeline
 * USER STORY: As the owner I want evidence, from the real components, that pushing to the OS git server runs the
 *             app's checks as a Tekton PipelineRun on that exact commit, that a red check blocks, that a newer push
 *             cancels the older run, that the network policies hold, and that another domain's app is untouched.
 * ARCHITECTURE:
 *   - REAL components, set up by tests/software-factory/tekton-e2e.sh: kind with Calico (an enforcing CNI),
 *     Tekton Pipelines v1 + Triggers (the pinned releases), the chart's own build namespace / listener / RBAC /
 *     NetworkPolicies / egress proxy (helm template), the OS's `git-http` image serving the bare repositories,
 *     the real npm registry through the egress proxy, Trivy and OPA in the pipeline.
 *   - THIS PROCESS PLAYS os-ui: the OS's own commit path writes the domain repository, the OS's own receive hooks
 *     and `handleReceive` run for a REAL `git push`, `registerAppIngest` starts the checks, and `syncAppChecks`
 *     copies Tekton's result into `App.checks`. Kubernetes is reached through `kubectl proxy`; the listener through
 *     `kubectl port-forward` (both loopback only).
 *   - EVERY ASSERTION reads the component's own record: the PipelineRun / TaskRun objects and pod logs from the
 *     Kubernetes API, Calico's enforcement (probe pods), git's own `remote:` lines.
 *   - NEGATIVE TWINS: a failing test blocks; a superseded run is cancelled; a deploy of a commit without a green
 *     record is refused; the app's code reaches only the egress proxy (direct egress, the git server, the listener
 *     are blocked; a host the proxy does not allow is refused); an app of another domain is untouched.
 *   - Skipped unless SF_KUBECONFIG, SF_REPOS_DIR are set (tests/software-factory/tekton-e2e.sh sets them).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const KUBECONFIG = process.env.SF_KUBECONFIG ?? '';
const REPOS = process.env.SF_REPOS_DIR ?? '';
const skip = KUBECONFIG && REPOS ? false : 'SF_KUBECONFIG / SF_REPOS_DIR not set (run tests/software-factory/tekton-e2e.sh)';
const NS = 'agentic-build';
const PLATFORM = 'agentic-os';
const run = promisify(execFile);
const realFetch = globalThis.fetch;
// The app store is offline in this process (no OpenSearch); loopback calls (kubectl proxy, the listener) are real.
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  return /^http:\/\/127\.0\.0\.1:/.test(url) ? realFetch(input, init) : Promise.reject(new Error('offline-stub'));
}) as typeof fetch;

const { config: cfg } = await import('@core/kernel/config');
const { testUser } = await import('@core/testing/user');
const { createApp, getAppBySlugInternal } = await import('./apps.ts');
const { registerAppIngest } = await import('./app-receive.ts');
const { __setChecksRunner, ensureChecksRecord } = await import('./tekton-checks.ts');
const { syncAppChecks } = await import('./checks-sync.ts');
const { runAppTests, requestDeploy } = await import('./review.ts');
const { recordVerdict, recordFor } = await import('./check-record.ts');
const { REQUIRED_GATES } = await import('./gates.ts');
const { registerRepoKind, ensureReceiveHooks, __clearRepoKinds, __resetHookMemo } = await import('@core/infra/git-receive');
const { handleReceive } = await import('@core/infra/git-receive-server');
const { createAccessToken, __resetAccessTokens } = await import('@core/auth/access-tokens-store');
const { openOrInit } = await import('@core/infra/git-store');

const kubectl = (args: string[]) => execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const kjson = <T = Record<string, unknown>>(args: string[]) => JSON.parse(kubectl([...args, '-o', 'json'])) as T;
const log = (m: string) => process.stderr.write(`[tekton-e2e ${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function waitFor(p: ChildProcess, re: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}`)), 30_000);
    const on = (b: Buffer) => { if (re.test(b.toString())) { clearTimeout(t); resolve(); } };
    p.stdout?.on('data', on);
    p.stderr?.on('data', on);
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`exited ${c}`)); });
  });
}

const procs: ChildProcess[] = [];
let server: Server | null = null;
let workDir = '';
let receiveUrl = '';
let token = '';
let k8sDeps: import('./tekton-checks.ts').ChecksDeps = {};

const dan = testUser({ id: 'dan', name: 'Dan', domains: ['sales'], role: 'builder' });
const hrUser = testUser({ id: 'hana', name: 'Hana', domains: ['hr'], role: 'builder' });
const principals: Record<string, { id: string; name: string; role: string; domains: string[] }> = {
  dan: { id: 'dan', name: 'Dan', role: 'builder', domains: ['sales'] },
};

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  OS_RECEIVE_URL: receiveUrl,
  HTTP_AUTHORIZATION: `Basic ${Buffer.from(`git:${token}`).toString('base64')}`,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});
const git = (clone: string, ...args: string[]) => run('git', ['-C', clone, ...args], { env: gitEnv() });

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(join(tmpdir(), 'sf-tekton-work-'));
  (cfg as { reposDir: string }).reposDir = REPOS;
  __clearRepoKinds();
  __resetAccessTokens();
  registerAppIngest();
  token = createAccessToken({ userId: 'dan', name: 'e2e' }).token;

  // os-ui's receive endpoint (loopback): the OS's own handler, behind the OS's own hooks.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const out = await handleReceive(
          body,
          { gitAuthorization: (req.headers['x-os-git-authorization'] as string) ?? null, authorization: (req.headers.authorization as string) ?? null },
          { lookup: async (id: string) => principals[id] ?? null, reposDir: REPOS, serviceBearerToken: '' },
        );
        res.writeHead(out.status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(out.body);
      })();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  receiveUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/git/receive`;

  // The Kubernetes API (kubectl proxy) and the Tekton EventListener (port-forward), both on loopback.
  const proxy = spawn('kubectl', ['--kubeconfig', KUBECONFIG, 'proxy', '--port=18071'], { stdio: 'pipe' });
  procs.push(proxy);
  await waitFor(proxy, /Starting to serve/);
  const pf = spawn('kubectl', ['--kubeconfig', KUBECONFIG, '-n', NS, 'port-forward', 'svc/el-app-checks', '18072:8080'], { stdio: 'pipe' });
  procs.push(pf);
  await waitFor(pf, /Forwarding from/);
  const call = async (method: string, path: string, body?: unknown, accept = 'application/json') => {
    const res = await realFetch(`http://127.0.0.1:18071${path}`, {
      method,
      headers: { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json', accept },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
  k8sDeps = {
    namespace: NS,
    listenerUrl: 'http://127.0.0.1:18072',
    k8s: async (method, path, body) => {
      try {
        const r = await call(method, path, body);
        return { status: r.status, body: r.text ? (JSON.parse(r.text) as Record<string, unknown>) : {} };
      } catch { return { status: 0, body: {} }; }
    },
    k8sText: async (path) => { try { return await call('GET', path, undefined, '*/*'); } catch { return { status: 0, text: '' }; } },
    post: async (url, json) => {
      try {
        const res = await realFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
        return { status: res.status, text: await res.text() };
      } catch (e) { return { status: 0, text: String(e) }; }
    },
    waitMs: 0,
  };
  __setChecksRunner((i) => ensureChecksRecord(i, k8sDeps));
});

after(async () => {
  __setChecksRunner(null);
  for (const p of procs) p.kill();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------------------------- helpers

type Run = { metadata: { name: string; labels: Record<string, string> }; spec: Record<string, unknown>; status?: { conditions?: { status: string; reason: string }[] } };
const runsOf = (slug: string, sha?: string) =>
  kjson<{ items: Run[] }>(['-n', NS, 'get', 'pipelinerun', '-l', `soa.dev/app=${slug}${sha ? `,soa.dev/sha=${sha}` : ''}`]).items;

async function waitRecord(slug: string, sha: string, minutes = 20) {
  const until = Date.now() + minutes * 60_000;
  let last = '';
  for (;;) {
    const app = (await getAppBySlugInternal(slug))!;
    await syncAppChecks(app, k8sDeps);
    const rec = recordFor((await getAppBySlugInternal(slug))!.checks, sha);
    const state = rec ? `${rec.status}:${rec.checks.map((c) => `${c.id}=${c.status}`).join(',')}` : 'no record';
    if (state !== last) { log(`${slug}@${sha.slice(0, 8)} ${state}`); last = state; }
    if (rec && rec.status !== 'running') return rec;
    if (Date.now() > until) throw new Error(`no finished record for ${slug}@${sha.slice(0, 8)} after ${minutes} min (${state})`);
    await sleep(8_000);
  }
}

let clone = '';
async function openClone(domain: string): Promise<string> {
  const dir = join(workDir, `clone-${domain}`);
  await run('git', ['clone', '-q', join(REPOS, `${domain}.git`), dir], { env: gitEnv() });
  await git(dir, 'config', 'user.email', 'dan@datamasterclass.com');
  await git(dir, 'config', 'user.name', 'Dan');
  return dir;
}
async function pushChange(dir: string, mutate: () => void, message: string): Promise<{ sha: string; out: string }> {
  mutate();
  await git(dir, 'commit', '-qam', message);
  const sha = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  const r = await git(dir, 'push', 'origin', 'HEAD:main');
  return { sha, out: `${r.stdout}\n${r.stderr}` };
}

const SLUG = 'order-desk';
let appId = '';
let hrAppId = '';
let green = { sha: '', runRef: '' };

// ----------------------------------------------------------------------------------------------- the proof

test('SETUP: apps from the template are committed to their domain repositories by the OS, with the pipeline in git', { skip, timeout: 300_000 }, async () => {
  const app = await createApp(dan, { name: 'Order Desk', template: 'nextjs-web' });
  appId = app.id;
  assert.equal(app.slug, SLUG);
  const hr = await createApp(hrUser, { name: 'Leave Tool', template: 'nextjs-web' });
  hrAppId = hr.id;
  __resetHookMemo();
  for (const d of ['sales', 'hr']) {
    await openOrInit(d, { reposDir: REPOS });
    ensureReceiveHooks(d, { reposDir: REPOS });
  }
  clone = await openClone('sales');
  const pipeline = readFileSync(join(clone, 'apps', SLUG, '.tekton', 'pipeline.yaml'), 'utf8');
  assert.match(pipeline, /kind: Pipeline/);
  assert.match(pipeline, /name: gates/);
});

test('GREEN: a real git push starts a Tekton PipelineRun for that exact commit; every gate and the scan pass; the OS records it per sha', { skip, timeout: 1_500_000 }, async () => {
  const { sha, out } = await pushChange(clone, () => appendFileSync(join(clone, 'apps', SLUG, 'README.md'), '\nA note from a developer.\n'), 'docs: a note');
  assert.match(out, new RegExp(`quality checks started for ${sha.slice(0, 12)} \\(chk-`), `git said:\n${out}`);

  // Tekton's own record: one PipelineRun for the sha, running the CHART's Pipeline `app-checks` (platform-owned): the app's own
  // copy in git is for ejecting, it never judges a commit here.
  const runs = runsOf(SLUG, sha);
  assert.equal(runs.length, 1, 'one PipelineRun per sha');
  const spec = runs[0].spec as { pipelineRef: { name: string; resolver?: string }; params: { name: string; value: string }[] };
  assert.equal(spec.pipelineRef.name, 'app-checks');
  assert.equal(spec.pipelineRef.resolver, undefined, 'the Pipeline is not resolved from the pushed repository');
  assert.ok(spec.params.some((p) => p.name === 'sha' && p.value === sha));
  assert.ok(spec.params.some((p) => p.name === 'slug' && p.value === SLUG));

  const rec = await waitRecord(SLUG, sha);
  assert.equal(rec.status, 'finished');
  assert.equal(rec.engine, 'tekton');
  assert.equal(rec.trigger, 'push');
  assert.equal(rec.runRef, runs[0].metadata.name);
  assert.deepEqual(rec.checks.map((c) => c.id), [...REQUIRED_GATES, 'scan']);
  assert.ok(rec.checks.every((c) => c.status === 'pass'), JSON.stringify(rec.checks.map((c) => [c.id, c.status, c.detail.slice(0, 200)])));
  assert.equal(recordVerdict(rec, sha).green, true);
  green = { sha, runRef: rec.runRef! };

  // The component's own status agrees with the record, and the run was on the pushed commit.
  const pr = kjson<Run & { status: { conditions: { status: string }[]; pipelineSpec: unknown } }>(['-n', NS, 'get', 'pipelinerun', rec.runRef!]);
  assert.equal(pr.status.conditions[0].status, 'True');
  const trs = kjson<{ items: { metadata: { labels: Record<string, string> }; status: { results?: { name: string; value: string }[]; steps: { name: string; terminated?: { exitCode: number } }[] } }[] }>(['-n', NS, 'get', 'taskrun', '-l', `tekton.dev/pipelineRun=${rec.runRef}`]);
  const fetchTr = trs.items.find((t) => t.metadata.labels['tekton.dev/pipelineTask'] === 'fetch')!;
  assert.equal(fetchTr.status.results?.find((r) => r.name === 'commit')?.value, sha, 'Tekton cloned exactly the pushed commit');
  const gatesTr = trs.items.find((t) => t.metadata.labels['tekton.dev/pipelineTask'] === 'gates')!;
  assert.deepEqual(gatesTr.status.steps.map((s) => `${s.name}:${s.terminated?.exitCode}`), ['install', ...REQUIRED_GATES, 'verdict'].map((n) => `${n}:0`));

  // The pod that ran the app's code is restricted: no ServiceAccount token, non-root, no privilege escalation, no capabilities.
  const podName = kjson<{ items: { metadata: { name: string } }[] }>(['-n', NS, 'get', 'pod', '-l', `tekton.dev/pipelineRun=${rec.runRef},tekton.dev/pipelineTask=gates`]).items[0].metadata.name;
  const pod = kjson<{ spec: { automountServiceAccountToken?: boolean; securityContext: { runAsNonRoot?: boolean }; containers: { name: string; securityContext?: { allowPrivilegeEscalation?: boolean; capabilities?: { drop?: string[] } }; resources: { limits?: Record<string, string> } }[] } }>(['-n', NS, 'get', 'pod', podName]);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  for (const c of pod.spec.containers) {
    assert.equal(c.securityContext?.allowPrivilegeEscalation, false, `${c.name} may not escalate`);
    assert.deepEqual(c.securityContext?.capabilities?.drop, ['ALL'], `${c.name} drops all capabilities`);
    assert.ok(c.resources.limits?.memory, `${c.name} has a memory limit`);
  }
});

test('IDEMPOTENT: a second trigger for the same sha (verify_app_gates) starts no new run and returns the recorded verdict', { skip, timeout: 120_000 }, async () => {
  const r = await runAppTests(appId, dan, { trigger: 'mcp', waitMs: 0 });
  assert.equal(r.commit, green.sha);
  assert.equal(r.record.runRef, green.runRef);
  assert.equal(r.verdict.passed, true);
  assert.equal(runsOf(SLUG, green.sha).length, 1);
});

test('NEGATIVE a failing test blocks: the push lands, the tests gate is red from the real test run, and a deploy of that commit is refused', { skip, timeout: 1_500_000 }, async () => {
  const { sha, out } = await pushChange(clone, () => {
    const f = join(clone, 'apps', SLUG, 'tests', 'healthz.test.ts');
    writeFileSync(f, readFileSync(f, 'utf8').replace('{ ok: true }', '{ ok: false }'));
  }, 'test: break healthz');
  assert.match(out, /quality checks started/);
  const rec = await waitRecord(SLUG, sha);
  const byId = Object.fromEntries(rec.checks.map((c) => [c.id, c]));
  assert.equal(byId.tests.status, 'fail');
  assert.match(byId.tests.detail, /not ok|fail|ok: false|Expected/i);
  for (const id of ['typecheck', 'lint', 'build', 'policy']) assert.equal(byId[id].status, 'pass', id);
  assert.equal(recordVerdict(rec, sha).green, false);
  // Tekton agrees: the PipelineRun failed.
  assert.equal(kjson<Run>(['-n', NS, 'get', 'pipelinerun', rec.runRef!]).status!.conditions![0].status, 'False');
  // Deploy is refused from the stored red record (no checks are re-run).
  await assert.rejects(requestDeploy(appId, dan, { scanMode: 'offline-mock' }), (e: Error & { status?: number }) => { assert.equal(e.status, 422); assert.match(e.message, /tests/); return true; });
});

test('NEGATIVE supersede: a newer push cancels the run still in progress with Tekton\'s spec.status Cancelled; only the head\'s result stands', { skip, timeout: 1_500_000 }, async () => {
  const mutate = (n: number) => () => appendFileSync(join(clone, 'apps', SLUG, 'README.md'), `\nedit ${n}\n`);
  const first = await pushChange(clone, mutate(1), 'docs: edit 1');
  assert.match(first.out, /quality checks started/);
  const firstRun = runsOf(SLUG, first.sha)[0];
  assert.ok(firstRun, 'the first push has a run');
  const second = await pushChange(clone, () => {
    // fix the test again and add a second edit, so the head is green
    const f = join(clone, 'apps', SLUG, 'tests', 'healthz.test.ts');
    writeFileSync(f, readFileSync(f, 'utf8').replace('{ ok: false }', '{ ok: true }'));
  }, 'test: fix healthz');
  assert.match(second.out, /was cancelled/, `git said:\n${second.out}`);
  const cancelled = kjson<Run>(['-n', NS, 'get', 'pipelinerun', firstRun.metadata.name]);
  assert.match(String(cancelled.spec.status), /^Cancelled/);
  assert.match(cancelled.status!.conditions![0].reason, /Cancel/i);
  const app = (await getAppBySlugInternal(SLUG))!;
  assert.equal(recordFor(app.checks, first.sha)!.status, 'superseded');
  assert.equal(recordVerdict(recordFor(app.checks, first.sha), first.sha).green, false, 'a superseded result is never read as green');
  const head = await waitRecord(SLUG, second.sha);
  assert.equal(head.status, 'finished');
  assert.ok(head.checks.every((c) => c.status === 'pass'), JSON.stringify(head.checks.map((c) => [c.id, c.status])));
  green = { sha: second.sha, runRef: head.runRef! };
});

test('"Run checks" (the button) on a finished head starts a new attempt for the same sha; the old attempt stays', { skip, timeout: 120_000 }, async () => {
  const r = await runAppTests(appId, dan, { trigger: 'button', force: true, waitMs: 0 });
  assert.equal(r.commit, green.sha);
  assert.equal(r.record.status, 'running');
  const runs = runsOf(SLUG, green.sha);
  assert.equal(runs.length, 2);
  assert.ok(runs.some((x) => x.metadata.labels['soa.dev/trigger'] === 'button'));
});

test('NEGATIVE another domain: an app of domain hr is untouched by a push to the sales repository, and has no run', { skip, timeout: 300_000 }, async () => {
  const before = runsOf('leave-tool').length;
  // The sales repository gets a folder named like the hr app: a push to it must not start hr's checks.
  const dir = join(clone, 'apps', 'leave-tool');
  execFileSync('mkdir', ['-p', dir]);
  const { out } = await pushChange(clone, () => { writeFileSync(join(dir, 'README.md'), 'not hr\'s file\n'); execFileSync('git', ['-C', clone, 'add', 'apps/leave-tool/README.md']); }, 'sales folder named like an hr app');
  assert.match(out, /belongs to domain 'hr'/, `git said:\n${out}`);
  assert.equal(runsOf('leave-tool').length, before, 'no PipelineRun for the hr app');
  const hr = (await getAppBySlugInternal('leave-tool'))!;
  assert.deepEqual(hr.checks ?? [], []);
  assert.equal(hr.domain, 'hr');
  assert.equal(hrAppId, hr.id);
});

// ----------------------------------------------------------------------------------- network policy (Calico)

async function probe(name: string, labels: Record<string, string>, ns: string, script: string): Promise<string> {
  const labelYaml = Object.entries(labels).map(([k, v]) => `    ${k}: "${v}"`).join('\n');
  const manifest = `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
${labelYaml || '    probe: "true"'}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 100, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: p
      image: curlimages/curl:8.11.1
      command: ["sh", "-c", ${JSON.stringify(script)}]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 100m, memory: 64Mi } }
`;
  execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, 'apply', '-f', '-'], { input: manifest, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 90; i++) {
      const phase = kjson<{ status: { phase: string } }>(['-n', ns, 'get', 'pod', name]).status.phase;
      if (phase === 'Succeeded' || phase === 'Failed') break;
      await sleep(2000);
    }
    return kubectl(['-n', ns, 'logs', name]).trim();
  } finally {
    kubectl(['-n', ns, 'delete', 'pod', name, '--wait=false']);
  }
}

test('NETWORK POLICY (Calico enforces): the app\'s code reaches the npm registry only through the egress proxy; everything else is blocked', { skip, timeout: 600_000 }, async () => {
  const gates = { 'tekton.dev/pipelineTask': 'gates' };
  const proxy = `http://egress-proxy.${PLATFORM}.svc.cluster.local:3128`;
  const [viaProxy, denied, direct, gitServer, listener, fromFetch, otherNs] = await Promise.all([
    probe('np-proxy', gates, NS, `curl -sS -m 25 -o /dev/null -w 'code=%{http_code}' -x ${proxy} https://registry.npmjs.org/-/ping; echo " exit=$?"`),
    probe('np-denied', gates, NS, `curl -sS -m 25 -o /dev/null -w 'connect=%{http_connect}' -x ${proxy} https://www.wikipedia.org/; echo " exit=$?"`),
    probe('np-direct', gates, NS, `curl -sS -m 8 -o /dev/null -w 'code=%{http_code}' https://registry.npmjs.org/-/ping; echo " exit=$?"`),
    probe('np-git', gates, NS, `curl -sS -m 8 -o /dev/null -w 'code=%{http_code}' http://os-git-http.${PLATFORM}.svc.cluster.local:9419/git/sales.git/info/refs?service=git-upload-pack; echo " exit=$?"`),
    probe('np-el', gates, NS, `curl -sS -m 8 -o /dev/null -w 'code=%{http_code}' http://el-app-checks.${NS}.svc.cluster.local:8080; echo " exit=$?"`),
    // the POSITIVE control: the clone step of a run may read the git server (so the block above is the policy, not a broken server)
    probe('np-fetch', { 'tekton.dev/pipelineTask': 'fetch' }, NS, `curl -sS -m 15 -o /dev/null -w 'code=%{http_code}' http://os-git-http.${PLATFORM}.svc.cluster.local:9419/git/sales.git/info/refs?service=git-upload-pack; echo " exit=$?"`),
    // another namespace may not reach the listener either: only os-ui may
    probe('np-other', {}, 'default', `curl -sS -m 8 -o /dev/null -w 'code=%{http_code}' http://el-app-checks.${NS}.svc.cluster.local:8080; echo " exit=$?"`),
  ]);
  log(`probes: proxy=[${viaProxy}] denied=[${denied}] direct=[${direct}] git=[${gitServer}] el=[${listener}] fetch=[${fromFetch}] other=[${otherNs}]`);
  assert.match(viaProxy, /code=200 exit=0/, 'the npm registry is reachable through the proxy (positive control)');
  assert.match(denied, /connect=403/, 'a host the proxy does not allow is refused by the proxy');
  assert.match(direct, /exit=28|exit=7|exit=6/, 'direct egress from the app\'s pod is blocked');
  assert.match(gitServer, /exit=28|exit=7/, 'the app\'s pod cannot reach the git server');
  assert.match(listener, /exit=28|exit=7/, 'the app\'s pod cannot reach the listener');
  assert.match(fromFetch, /code=200 exit=0/, 'the clone step can read the git server (so the block is the policy)');
  assert.match(otherNs, /exit=28|exit=7/, 'another namespace cannot reach the listener');
});
