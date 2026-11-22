/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Software — per app: status, the review card's scan (engine, severity), pod health,
 *             error rate in the logs. CI/CD results are not recorded anywhere, and the panel says so.
 * USER STORY: As an app owner or a builder I want to see which of my apps are really serving, what the security
 *             scan found and which engine ran it, whether the pods are healthy, and how many log lines are errors —
 *             and I never want "0" where nothing answered, or "clean" where no engine ran.
 * ARCHITECTURE: the app list and the review cards are injected (`sources.ts`); the pod read is the real
 *   `k8s()` client's shape and the log read is the real VictoriaLogs adapter's — both recorded here, proven on a
 *   real API server (kind) and a real VictoriaLogs in `software-panel.int.test.ts`. Twins: another domain's app
 *   and a foreign pod / foreign log row never reach the payload; Kubernetes or VictoriaLogs down → unavailable
 *   with the reason, the numbers absent; a declarative app has no pods to count; no log lines → no rate, not 0%.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
const asked: { path?: string; logsql?: string } = {};
let k8sMode: 'ok' | 'down' | 'forbidden' = 'ok';
let logsMode: 'ok' | 'down' | 'empty' = 'ok';
const pod = (name: string, app: string, o: { phase?: string; ready?: boolean; restarts?: number; waiting?: string; term?: string } = {}) => ({
  metadata: { name, labels: { 'app.kubernetes.io/name': app, 'app.kubernetes.io/part-of': 'sovereign-os-apps' } },
  status: {
    phase: o.phase ?? 'Running',
    startTime: '2026-11-22T08:00:00Z',
    containerStatuses: [{ name: 'app', ready: o.ready ?? true, restartCount: o.restarts ?? 0, state: o.waiting ? { waiting: { reason: o.waiting } } : { running: {} }, ...(o.term ? { lastState: { terminated: { reason: o.term } } } : {}) }],
  },
});
mock.module('@core/infra/k8s', {
  namedExports: {
    k8s: async (_m: string, path: string) => {
      asked.path = path;
      if (k8sMode === 'down') return { status: 0, body: {} };
      if (k8sMode === 'forbidden') return { status: 403, body: {} };
      return { status: 200, body: { items: [
        pod('app-orders-7d9f-abcde', 'app-orders'),
        pod('app-crashy-5c4b-xyz12', 'app-crashy', { ready: false, restarts: 9, waiting: 'CrashLoopBackOff', term: 'Error' }),
        pod('app-secret-1a2b-qwert', 'app-secret'), // another domain's app: asked-for names only
      ] } };
    },
  },
});
mock.module('@core/adapters/victoria-logs/query', {
  namedExports: {
    ...(await real('@core/adapters/victoria-logs/query')),
    logsQuery: async (q: string) => {
      asked.logsql = q;
      if (logsMode === 'down') return { ok: false, reason: 'unreachable', detail: 'VictoriaLogs did not answer', at: '' };
      if (logsMode === 'empty') return { ok: true, at: '', value: [] };
      return { ok: true, at: '', value: [
        { 'k8s.pod.name': 'app-orders-7d9f-abcde', lines: '200', errors: '10' },
        { 'k8s.pod.name': 'app-orders-7d9f-zzzzz', lines: '100', errors: '5' },
        { 'k8s.pod.name': 'app-secret-1a2b-qwert', lines: '50', errors: '50' },
      ] };
    },
  },
});

const { registerMonitoringSources } = await import('./sources');
const { softwareView } = await import('./software-panel');

const scan = (o: Record<string, unknown> = {}) => ({ mode: 'live', engine: 'trivy', passed: true, unavailable: false, reason: null, notRun: ['sast'], truncated: false, scannedAt: '2026-11-21T10:00:00Z', byCategory: { secrets: 0, sast: 0, deps: 1, container: 0 }, bySeverity: { critical: 0, high: 0, medium: 1, low: 0, info: 0 }, ...o });
const app = (o: Record<string, unknown>) => ({ id: 'a1', slug: 'orders', name: 'Orders', domain: 'sales', scope: 'mine' as const, serveMode: 'image' as const, runner: 'app-orders', status: { label: 'Live', servedUrl: 'https://orders.example' }, checks: null as never, review: { requestedAt: '2026-11-21T09:00:00Z', decision: 'approved', decidedAt: '2026-11-21T10:05:00Z', scan: scan() }, ...o });
let apps: ReturnType<typeof app>[] = [];
registerMonitoringSources({
  agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
  // A careless reader: everything, whoever asks.
  software: async () => apps,
});
const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const admin = { id: 'root', name: 'Root', domains: ['sales', 'hr'], allDomains: ['sales', 'hr'], activeDomain: null, role: 'admin' } as never;

beforeEach(() => {
  k8sMode = 'ok'; logsMode = 'ok'; asked.path = undefined; asked.logsql = undefined;
  apps = [
    app({}),
    app({ id: 'a2', slug: 'crashy', name: 'Crashy', runner: 'app-crashy', status: { label: 'Approved · not serving yet', servedUrl: null }, review: { requestedAt: '2026-11-21T09:00:00Z', decision: 'pending', decidedAt: null, scan: scan({ passed: false, bySeverity: { critical: 1, high: 2, medium: 0, low: 0, info: 0 } }) } }),
    app({ id: 'a3', slug: 'wiki', name: 'Wiki', serveMode: 'spec', runner: null, status: { label: 'Published', servedUrl: '/apps/wiki' }, review: null }),
    app({ id: 'a4', slug: 'secret', name: 'HR secret', domain: 'hr', runner: 'app-secret' }),
  ];
});

test('per app: status word, the scan with its engine and severities, the last review decision', async () => {
  const v = await softwareView(ada);
  const by = Object.fromEntries(v.apps.map((a) => [a.id, a]));
  assert.equal(by.a1.status.label, 'Live');
  assert.equal(by.a1.scan!.engine, 'trivy');
  assert.equal(by.a1.scan!.verdict, 'passed');
  assert.deepEqual(by.a1.scan!.notRun, ['sast']);
  assert.equal(by.a1.review!.decision, 'approved');
  assert.equal(by.a2.scan!.verdict, 'failed');
  assert.equal(by.a2.scan!.bySeverity.critical, 1);
  assert.equal(by.a3.scan, null, 'an app never reviewed has no scan (not "clean")');
});

test('scope: another domain\'s app is dropped even when the reader returns it; so are its pods and log rows', async () => {
  const v = await softwareView(ada);
  assert.ok(!v.apps.some((a) => a.id === 'a4'));
  assert.ok(!JSON.stringify(v).includes('HR secret') && !JSON.stringify(v).includes('app-secret'));
  assert.ok(!asked.logsql!.includes('app-secret'), 'the log query names only the asked apps');
  const adm = await softwareView(admin);
  assert.ok(adm.apps.some((a) => a.id === 'a4'));
});

test('no engine ran: the verdict is "no_verdict" with the reason, never "passed" (twin)', async () => {
  apps = [app({ review: { requestedAt: 'x', decision: 'pending', decidedAt: null, scan: scan({ mode: 'unavailable', engine: null, passed: false, unavailable: true, reason: 'The live security scanner is switched off' }) } })];
  const v = await softwareView(ada);
  assert.equal(v.apps[0].scan!.verdict, 'no_verdict');
  assert.match(v.apps[0].scan!.reason!, /switched off/);
});

test('pods come from the Kubernetes API; a crash-looping pod is named as such; restarts are counted', async () => {
  const v = await softwareView(ada);
  const by = Object.fromEntries(v.apps.map((a) => [a.id, a]));
  assert.match(asked.path!, /\/api\/v1\/namespaces\/[^/]+\/pods\?labelSelector=/);
  assert.equal(by.a1.pods!.state, 'running');
  assert.equal(by.a1.pods!.items[0].restarts, 0);
  assert.equal(by.a2.pods!.state, 'crash_looping');
  assert.equal(by.a2.pods!.items[0].restarts, 9);
  assert.equal(by.a2.pods!.items[0].lastTerminated, 'Error');
});

test('a declarative app has no pods to count (not_applicable), distinct from an image app whose pods are absent', async () => {
  const v = await softwareView(ada);
  assert.equal(v.apps.find((a) => a.id === 'a3')!.pods, null);
  apps = [app({ slug: 'ghost', runner: 'app-ghost' })];
  const w = await softwareView(ada);
  assert.equal(w.apps[0].pods!.state, 'no_pods');
});

test('Kubernetes not answering: pods unavailable with the reason, no zero pods', async () => {
  k8sMode = 'down';
  const v = await softwareView(ada);
  assert.equal(v.sources.pods.state, 'unavailable');
  assert.ok(v.apps.every((a) => a.pods === null || a.pods.state === 'unknown'));
  assert.ok(!v.apps.some((a) => a.pods?.state === 'no_pods'));
  k8sMode = 'forbidden';
  assert.match((await softwareView(ada)).sources.pods.state === 'unavailable' ? ((await softwareView(ada)).sources.pods as { reason: string }).reason : '', /403/);
});

test('error rate is errors / lines over the app\'s pods (two replicas summed); another app\'s rows are not folded in', async () => {
  const v = await softwareView(ada);
  const o = v.apps.find((a) => a.id === 'a1')!.logs!;
  assert.deepEqual({ lines: o.lines, errors: o.errors }, { lines: 300, errors: 15 });
  assert.equal(o.errorRate, 0.05);
});

test('no log lines: no rate (null), not 0%; VictoriaLogs down: unavailable', async () => {
  logsMode = 'empty';
  const v = await softwareView(ada);
  assert.equal(v.apps.find((a) => a.id === 'a1')!.logs!.errorRate, null);
  assert.equal(v.apps.find((a) => a.id === 'a1')!.logs!.lines, 0);
  logsMode = 'down';
  const w = await softwareView(ada);
  assert.equal(w.sources.logs.state, 'unavailable');
  assert.ok(w.apps.every((a) => a.logs === null));
});

const rec = (o: Record<string, unknown> = {}) => ({ sha: 'abc1234567890', status: 'finished', trigger: 'push', engine: 'sandbox-job', runRef: 'job-1', startedAt: '2026-11-22T08:00:00Z', finishedAt: '2026-11-22T08:02:00Z', error: null, checks: [{ id: 'build', status: 'pass', detail: 'ok' }, { id: 'test', status: 'pass', detail: 'ok' }], ...o });

test('CI/CD: the newest recorded check run is shown from App.checks; an app with none says not_recorded (twin)', async () => {
  apps = [app({ checks: [rec(), rec({ sha: 'old', checks: [{ id: 'build', status: 'fail', detail: 'x' }] })] as never }), app({ id: 'a9', slug: 'orders2', runner: 'app-orders2', checks: null as never })];
  const v = await softwareView(ada);
  const ci = v.apps.find((a) => a.id === 'a1')!.ci;
  assert.equal(ci.state, 'recorded');
  assert.equal(ci.state === 'recorded' && ci.overall, 'passed');
  assert.equal(ci.state === 'recorded' && ci.engine, 'sandbox-job');
  assert.deepEqual(v.apps.find((a) => a.id === 'a9')!.ci, { state: 'not_recorded' });
});

test('CI/CD: a failing gate is failed; a record whose run could not start or is still running is never "passed"', async () => {
  const of = async (r: Record<string, unknown>) => { apps = [app({ checks: [rec(r)] as never })]; const ci = (await softwareView(ada)).apps[0].ci; return ci.state === 'recorded' ? ci.overall : ci.state; };
  assert.equal(await of({ checks: [{ id: 'build', status: 'pass', detail: '' }, { id: 'test', status: 'fail', detail: 'boom' }] }), 'failed');
  assert.equal(await of({ checks: [], error: 'sandbox failed: no cluster' }), 'unavailable');
  assert.equal(await of({ checks: [{ id: 'build', status: 'unavailable', detail: '' }] }), 'unavailable');
  assert.equal(await of({ status: 'running', finishedAt: null }), 'running');
});

test('CI/CD results are said to be not recorded for an app with no record; the review decision is also shown', async () => {
  const v = await softwareView(ada);
  const n = v.notUpstream.find((x) => /CI/.test(x.panel))!;
  assert.ok(n);
  assert.match(n.reason, /not recorded/i);
});

test('the source reader not registered or failing is "unavailable" with the reason, not "no apps"', async () => {
  registerMonitoringSources({ agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map() });
  const v = await softwareView(ada);
  assert.equal(v.sources.inventory.state, 'unavailable');
  assert.equal(v.summary, null);
});
