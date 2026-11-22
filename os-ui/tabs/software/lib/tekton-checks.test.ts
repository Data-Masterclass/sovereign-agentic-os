/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory CI - start one Tekton run per commit, cancel the superseded one, read the result
 * USER STORY: As a builder I want every push, every "Run checks" press and every verify_app_gates call to
 *             start the same checks for the commit, once, and a newer push to stop the older run, so
 *             the app shows what is true of its head.
 * ARCHITECTURE: The glue (tekton-checks.ts) against a scripted Kubernetes API and listener: it only POSTs to the
 *             Triggers EventListener, lists/patches PipelineRuns and reads TaskRuns and pod logs. It starts no
 *             pod, queues nothing and stores nothing. The real components are proven in
 *             tests/software-factory/tekton-e2e.sh (kind + Calico + Tekton).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startChecksRun, readChecksRecord, ensureChecksRecord, type ChecksDeps } from './tekton-checks.ts';
import { checksRunName } from './tekton-record.ts';
import { GATES_REPORT_DELIM, REQUIRED_GATES } from './gates.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NS = 'agentic-build';

type PR = { metadata: { name: string; labels: Record<string, string>; creationTimestamp: string }; spec: { status?: string }; status?: Record<string, unknown> };
function cluster(opts: { down?: boolean; listener?: number } = {}) {
  const runs: PR[] = [];
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const posts: { url: string; body: Record<string, string> }[] = [];
  let t = 0;
  const sel = (path: string) => {
    const m = /labelSelector=([^&]+)/.exec(path);
    return m ? Object.fromEntries(decodeURIComponent(m[1]).split(',').map((p) => p.split('=') as [string, string])) : {};
  };
  const k8s: ChecksDeps['k8s'] = async (method, path, body) => {
    calls.push({ method, path, body });
    if (opts.down) return { status: 0, body: {} };
    if (method === 'GET' && path.includes('/pipelineruns?')) {
      const want = sel(path);
      return { status: 200, body: { items: runs.filter((r) => Object.entries(want).every(([k, v]) => r.metadata.labels[k] === v)) } };
    }
    if (method === 'GET' && path.includes('/pipelineruns/')) {
      const r = runs.find((x) => path.endsWith(`/${x.metadata.name}`));
      return r ? { status: 200, body: r as never } : { status: 404, body: {} };
    }
    if (method === 'PATCH' && path.includes('/pipelineruns/')) {
      const r = runs.find((x) => path.endsWith(`/${x.metadata.name}`));
      if (!r) return { status: 404, body: {} };
      Object.assign(r.spec, (body as { spec: object }).spec);
      return { status: 200, body: r as never };
    }
    if (method === 'GET' && path.includes('/taskruns?')) return { status: 200, body: { items: [] } };
    return { status: 404, body: {} };
  };
  const post: ChecksDeps['post'] = async (url, json) => {
    const body = json as Record<string, string>;
    posts.push({ url, body });
    if (opts.listener && opts.listener !== 202) return { status: opts.listener, text: 'refused' };
    // The EventListener creates the PipelineRun from the TriggerTemplate: name and labels come from the body.
    runs.push({
      metadata: { name: body.runName, creationTimestamp: `2026-11-22T10:00:${String(10 + ++t).padStart(2, '0')}Z`, labels: { 'soa.dev/app': body.slug, 'soa.dev/sha': body.sha, 'soa.dev/trigger': body.trigger } },
      spec: {},
    });
    return { status: 202, text: '{"eventID":"x"}' };
  };
  const deps: ChecksDeps = { k8s, post, k8sText: async () => ({ status: 404, text: '' }), namespace: NS, listenerUrl: 'http://el-app-checks.agentic-build.svc.cluster.local:8080', sleep: async () => {}, now: () => 0 };
  return { runs, calls, posts, deps };
}
const input = (over: Record<string, unknown> = {}) => ({ slug: 'order-desk', domain: 'sales', sha: A, trigger: 'push' as const, ...over });

test('a push starts exactly one run: one POST to the EventListener carrying slug, domain, repo, sha, run name and trigger', async () => {
  const c = cluster();
  const r = await startChecksRun(input(), c.deps);
  assert.equal(r.ok, true);
  assert.equal(c.posts.length, 1);
  assert.equal(c.posts[0].url, 'http://el-app-checks.agentic-build.svc.cluster.local:8080');
  assert.deepEqual(c.posts[0].body, { slug: 'order-desk', domain: 'sales', repo: 'sales.git', sha: A, runName: checksRunName('order-desk', A, 1), trigger: 'push' });
  assert.equal(c.runs.length, 1);
  if (r.ok) assert.equal(r.runRef, checksRunName('order-desk', A, 1));
});

test('IDEMPOTENT per sha: a repeat trigger for a sha that has a run starts nothing and returns that run', async () => {
  const c = cluster();
  const first = await startChecksRun(input(), c.deps);
  const again = await startChecksRun(input({ trigger: 'mcp' }), c.deps);
  assert.equal(c.posts.length, 1);
  assert.equal(c.runs.length, 1);
  assert.equal(again.ok && first.ok && again.runRef === first.runRef, true);
  assert.equal(again.ok && again.created, false);
});

test('"Run checks" (force) on a finished sha starts a new attempt; while the run is still running it returns the running one', async () => {
  const c = cluster();
  await startChecksRun(input(), c.deps);
  const running = await startChecksRun(input({ trigger: 'button', force: true }), c.deps);
  assert.equal(c.posts.length, 1, 'a run in progress is not duplicated');
  assert.equal(running.ok && running.created, false);
  c.runs[0].status = { completionTime: '2026-11-22T10:05:00Z', conditions: [{ type: 'Succeeded', status: 'True' }] };
  const second = await startChecksRun(input({ trigger: 'button', force: true }), c.deps);
  assert.equal(c.posts.length, 2);
  assert.equal(second.ok && second.runRef, checksRunName('order-desk', A, 2));
});

test('SUPERSEDE: a push of a new sha cancels the in-progress run of the same app with spec.status Cancelled, and reports the sha', async () => {
  const c = cluster();
  await startChecksRun(input(), c.deps);
  const r = await startChecksRun(input({ sha: B }), c.deps);
  assert.equal(r.ok, true);
  const patches = c.calls.filter((x) => x.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body, { spec: { status: 'Cancelled' } });
  assert.match(patches[0].path, new RegExp(`/pipelineruns/${checksRunName('order-desk', A, 1)}$`));
  assert.equal(c.runs[0].spec.status, 'Cancelled');
  assert.equal(c.runs[1].spec.status, undefined, 'the new run is not cancelled');
  if (r.ok) assert.deepEqual(r.superseded, [A]);
});

test('NEGATIVE supersede: a finished run, another app\'s run and the same sha are never cancelled', async () => {
  const c = cluster();
  await startChecksRun(input(), c.deps);
  c.runs[0].status = { completionTime: '2026-11-22T10:05:00Z', conditions: [{ type: 'Succeeded', status: 'True' }] };
  await startChecksRun(input({ slug: 'other-app', sha: A }), c.deps);
  await startChecksRun(input({ sha: B }), c.deps);
  assert.equal(c.calls.filter((x) => x.method === 'PATCH').length, 0, 'the finished run and the other app\'s run are untouched');
  assert.ok(c.calls.filter((x) => x.method === 'GET' && x.path.includes('labelSelector=')).every((x) => decodeURIComponent(x.path).includes('soa.dev/app=')), 'every run lookup is scoped to one app');
});

test('NEGATIVE no engine configured: nothing is started and the reason says so', async () => {
  const c = cluster();
  const r = await startChecksRun(input(), { ...c.deps, listenerUrl: '', namespace: '' });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.kind, 'not-configured');
  assert.match(r.ok ? '' : r.reason, /Tekton/);
  assert.equal(c.posts.length, 0);
});

test('NEGATIVE no Kubernetes API: no-cluster, nothing posted', async () => {
  const c = cluster({ down: true });
  const r = await startChecksRun(input(), c.deps);
  assert.equal(r.ok ? '' : r.kind, 'no-cluster');
  assert.equal(c.posts.length, 0);
});

test('NEGATIVE the listener refuses the event (the CEL filter): refused, with its answer', async () => {
  const c = cluster({ listener: 400 });
  const r = await startChecksRun(input(), c.deps);
  assert.equal(r.ok ? '' : r.kind, 'refused');
  assert.match(r.ok ? '' : r.reason, /400/);
});

test('NEGATIVE inputs the listener would reject are refused before any call (slug, sha, domain)', async () => {
  const c = cluster();
  for (const bad of [{ sha: 'abc' }, { slug: 'Bad Slug' }, { domain: '../x' }]) {
    const r = await startChecksRun(input(bad), c.deps);
    assert.equal(r.ok ? '' : r.kind, 'refused', JSON.stringify(bad));
  }
  assert.equal(c.posts.length, 0);
  assert.equal(c.calls.length, 0);
});

test('the listener accepting an event that never becomes a PipelineRun is a failure, not a started run', async () => {
  const c = cluster();
  c.deps.post = async () => ({ status: 202, text: '{}' });
  const r = await startChecksRun(input(), c.deps);
  assert.equal(r.ok ? '' : r.kind, 'refused');
  assert.match(r.ok ? '' : r.reason, /no PipelineRun/);
});

test('readChecksRecord: none for a sha with no run; a running record for a run in progress; the cluster being down is distinct', async () => {
  const c = cluster();
  assert.deepEqual(await readChecksRecord('order-desk', A, c.deps), { kind: 'none' });
  await startChecksRun(input(), c.deps);
  const got = await readChecksRecord('order-desk', A, c.deps);
  assert.equal(got.kind, 'record');
  assert.equal(got.kind === 'record' && got.record.status, 'running');
  assert.equal(got.kind === 'record' && got.record.sha, A);
  assert.equal((await readChecksRecord('order-desk', A, cluster({ down: true }).deps)).kind, 'no-cluster');
});

test('readChecksRecord reads the newest run of the sha and each step log from the TaskRun pod', async () => {
  const c = cluster();
  await startChecksRun(input(), c.deps);
  c.runs[0].status = { startTime: '2026-11-22T10:00:01Z', completionTime: '2026-11-22T10:03:00Z', conditions: [{ type: 'Succeeded', status: 'True', reason: 'Succeeded' }] };
  const logsAsked: string[] = [];
  const steps = ['install', ...REQUIRED_GATES, 'verdict'].map((n) => ({ name: n, container: `step-${n}`, terminated: { exitCode: 0 } }));
  const base = c.deps.k8s!;
  c.deps.k8s = async (m, p, b) => {
    if (m === 'GET' && p.includes('/taskruns?')) {
      return { status: 200, body: { items: [{ metadata: { name: 'tr-gates', labels: { 'tekton.dev/pipelineTask': 'gates' } }, status: { podName: 'tr-gates-pod', conditions: [{ type: 'Succeeded', status: 'True' }], steps } }] } };
    }
    return base(m, p, b);
  };
  c.deps.k8sText = async (p) => {
    logsAsked.push(p);
    const id = /container=step-([a-z]+)/.exec(p)![1];
    return { status: 200, text: `${GATES_REPORT_DELIM}\n${JSON.stringify({ schema: 'os-gates/v1', template: 't', ok: true, gates: [{ id, status: 'pass', detail: `${id} fine` }] })}\n` };
  };
  const got = await readChecksRecord('order-desk', A, c.deps);
  assert.equal(got.kind, 'record');
  if (got.kind !== 'record') return;
  assert.ok(logsAsked.every((p) => p.startsWith(`/api/v1/namespaces/${NS}/pods/tr-gates-pod/log?container=step-`)));
  assert.deepEqual(got.record.checks.filter((c) => (REQUIRED_GATES as readonly string[]).includes(c.id)).map((c) => `${c.id}:${c.status}`), REQUIRED_GATES.map((g) => `${g}:pass`));
});

test('ensureChecksRecord: starts, then waits for the run; a run that outlives the wait comes back as `running`, not as a verdict', async () => {
  const c = cluster();
  let clock = 0;
  const deps: ChecksDeps = { ...c.deps, waitMs: 3_000, now: () => clock, sleep: async (ms) => { clock += ms; } };
  const out = await ensureChecksRecord(input(), deps);
  assert.equal(out.record.status, 'running');
  assert.equal(c.posts.length, 1);
  const again = await ensureChecksRecord(input(), deps);
  assert.equal(again.record.status, 'running');
  assert.equal(c.posts.length, 1, 'idempotent per sha');
});

test('ensureChecksRecord reports the superseded shas of the runs it cancelled, and an engine problem as a finished record with the reason', async () => {
  const c = cluster();
  await startChecksRun(input(), c.deps);
  const out = await ensureChecksRecord(input({ sha: B }), { ...c.deps, waitMs: 0 });
  assert.deepEqual(out.superseded, [A]);
  const down = await ensureChecksRecord(input(), { ...cluster({ down: true }).deps, waitMs: 0 });
  assert.equal(down.record.status, 'finished');
  assert.match(down.record.error ?? '', /Kubernetes/);
  const none = await ensureChecksRecord(input(), { ...c.deps, listenerUrl: '', namespace: '', waitMs: 0 });
  assert.match(none.record.error ?? '', /Tekton/);
  assert.equal(none.record.runRef, null);
});
