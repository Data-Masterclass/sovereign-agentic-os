/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cronJobName,
  isValidCron,
  buildCronJobManifest,
  reconcileScheduleCron,
  resyncScheduleCrons,
  scheduleBootCronResync,
  type CronK8s,
} from '@tabs/agents/lib/schedule-cron';

const OPTS = {
  namespace: 'agentic-os',
  targetUrl: 'http://os-ui:3000/api/agents/scheduled-run',
  image: 'curlimages/curl:8.11.1',
  tokenSecret: 'agent-runtime-token',
  tokenSecretKey: 'token',
};

/** A recording mock k8s client driven by a per-path response table. */
function mockK8s(responses: Record<string, { status: number; body?: Record<string, unknown> }>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client: CronK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = responses[`${method} ${path}`] ?? responses[method] ?? { status: 0, body: {} };
    return { status: r.status, body: r.body ?? {} };
  };
  return { client, calls };
}

test('cronJobName is deterministic + RFC1123-safe (underscores → dashes)', () => {
  assert.equal(cronJobName('sys_ab12cd34'), 'agent-schedule-sys-ab12cd34');
  assert.equal(cronJobName('sys_ab12cd34'), cronJobName('sys_ab12cd34'));
  assert.match(cronJobName('sys_ab12cd34'), /^[a-z0-9-]+$/);
});

test('isValidCron requires exactly 5 fields', () => {
  assert.ok(isValidCron('0 9 * * 1'));
  assert.ok(!isValidCron('0 9 * *'));
  assert.ok(!isValidCron(''));
  assert.ok(!isValidCron(undefined));
});

test('manifest curls the receiver with the bearer from a Secret (never inlined)', () => {
  const m = buildCronJobManifest('sys_x1', '0 9 * * 1', OPTS) as any;
  assert.equal(m.kind, 'CronJob');
  assert.equal(m.spec.schedule, '0 9 * * 1');
  const container = m.spec.jobTemplate.spec.template.spec.containers[0];
  const tokenEnv = container.env.find((e: any) => e.name === 'RUNTIME_TOKEN');
  assert.ok(tokenEnv.valueFrom.secretKeyRef, 'token comes from a secretKeyRef, not a literal value');
  assert.equal(tokenEnv.value, undefined);
  const payloadEnv = container.env.find((e: any) => e.name === 'PAYLOAD');
  assert.equal(payloadEnv.value, JSON.stringify({ systemId: 'sys_x1' }));
  // No secret bytes anywhere in the serialized spec.
  assert.ok(!JSON.stringify(m).includes('dev-only-insecure'));
});

test('cron save CREATES a CronJob when none exists (GET 404 → POST 201)', async () => {
  const { client, calls } = mockK8s({
    'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/agent-schedule-sys-1': { status: 404 },
    'POST /apis/batch/v1/namespaces/agentic-os/cronjobs': { status: 201 },
  });
  const out = await reconcileScheduleCron('sys_1', { kind: 'cron', cron: '0 9 * * 1' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.live, true);
  assert.equal(out.action, 'created');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST']);
});

test('cron re-save UPDATES the existing CronJob idempotently (GET 200 → PUT 200)', async () => {
  const { client, calls } = mockK8s({
    'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/agent-schedule-sys-1': { status: 200, body: { metadata: { resourceVersion: '4242' } } },
    'PUT /apis/batch/v1/namespaces/agentic-os/cronjobs/agent-schedule-sys-1': { status: 200 },
  });
  const out = await reconcileScheduleCron('sys_1', { kind: 'cron', cron: '*/5 * * * *' }, { ...OPTS, k8s: client });
  assert.equal(out.action, 'updated');
  assert.equal(out.ok, true);
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal((put.body as any).metadata.resourceVersion, '4242', 'replace carries the resourceVersion');
});

test('clearing the schedule (manual) DELETES the CronJob', async () => {
  const { client, calls } = mockK8s({
    'DELETE /apis/batch/v1/namespaces/agentic-os/cronjobs/agent-schedule-sys-1': { status: 200 },
  });
  const out = await reconcileScheduleCron('sys_1', { kind: 'manual' }, { ...OPTS, k8s: client });
  assert.equal(out.action, 'deleted');
  assert.equal(out.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ['DELETE']);
});

test('clearing when nothing exists is a benign no-op (DELETE 404 → ok)', async () => {
  const { client } = mockK8s({ DELETE: { status: 404 } });
  const out = await reconcileScheduleCron('sys_1', { kind: 'event', event: 'on_demand' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'noop');
});

test('HONESTY: an unreachable API server never claims success (status 0)', async () => {
  const { client } = mockK8s({ GET: { status: 0 }, DELETE: { status: 0 } });
  const save = await reconcileScheduleCron('sys_1', { kind: 'cron', cron: '0 9 * * 1' }, { ...OPTS, k8s: client });
  assert.equal(save.ok, false);
  assert.equal(save.live, false);
  assert.match(save.detail, /unreachable/i);
  const clear = await reconcileScheduleCron('sys_1', { kind: 'manual' }, { ...OPTS, k8s: client });
  assert.equal(clear.ok, false);
  assert.match(clear.detail, /unreachable/i);
});

test('HONESTY: a cluster rejection surfaces as a non-ok outcome', async () => {
  const { client } = mockK8s({
    'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/agent-schedule-sys-1': { status: 404 },
    'POST /apis/batch/v1/namespaces/agentic-os/cronjobs': { status: 422 },
  });
  const out = await reconcileScheduleCron('sys_1', { kind: 'cron', cron: '0 9 * * 1' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.match(out.detail, /422/);
});

test('an invalid cron is refused before any k8s call', async () => {
  const { client, calls } = mockK8s({});
  const out = await reconcileScheduleCron('sys_1', { kind: 'cron', cron: 'not-a-cron' }, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.match(out.detail, /Invalid cron/);
  assert.equal(calls.length, 0);
});

// ---- 2026-11-26: the CronJob os-ui provisions must be able to START and must be governed by
// the schedule egress policy. Before this, the default Secret reference was `os-ui` /
// `agent-runtime-token` — a Secret the chart never renders — so every provisioned CronJob pod
// stuck in CreateContainerConfigError and no saved cron schedule ever fired.

test('DEFAULTS: the bearer is read from the chart Secret agent-runtime-token / token (the one os-ui validates against)', async () => {
  const { client, calls } = mockK8s({
    'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/agent-schedule-sys-1': { status: 404 },
    'POST /apis/batch/v1/namespaces/agentic-os/cronjobs': { status: 201 },
  });
  // No tokenSecret / tokenSecretKey override: the live defaults are what a cluster provisions.
  const out = await reconcileScheduleCron('sys_1', { kind: 'cron', cron: '*/5 * * * *' }, { k8s: client, namespace: 'agentic-os' });
  assert.equal(out.ok, true);
  const post = calls.find((c) => c.method === 'POST')!;
  const container = (post.body as any).spec.jobTemplate.spec.template.spec.containers[0];
  const ref = container.env.find((e: any) => e.name === 'RUNTIME_TOKEN').valueFrom.secretKeyRef;
  assert.deepEqual(ref, { name: 'agent-runtime-token', key: 'token' });
});

test('POD: carries component=agent-schedule so the dedicated egress policy (os-ui + DNS only) governs it', () => {
  const m = buildCronJobManifest('sys_x1', '0 9 * * 1', OPTS) as any;
  const tpl = m.spec.jobTemplate.spec.template;
  assert.equal(tpl.metadata?.labels?.['app.kubernetes.io/component'], 'agent-schedule');
});

test('POD: runs restricted — non-root, no privilege escalation, no capabilities, read-only root fs, RuntimeDefault seccomp', () => {
  const m = buildCronJobManifest('sys_x1', '0 9 * * 1', OPTS) as any;
  const spec = m.spec.jobTemplate.spec.template.spec;
  assert.equal(spec.securityContext?.runAsNonRoot, true);
  assert.equal(spec.securityContext?.seccompProfile?.type, 'RuntimeDefault');
  const c = spec.containers[0];
  assert.equal(c.securityContext?.allowPrivilegeEscalation, false);
  assert.deepEqual(c.securityContext?.capabilities?.drop, ['ALL']);
  assert.equal(c.securityContext?.readOnlyRootFilesystem, true);
  assert.ok(c.resources?.limits?.memory, 'a curl has a memory limit');
  assert.equal(spec.automountServiceAccountToken, false, 'a curl to os-ui needs no API-server credential');
});

// ---- 2026-11-26 (F1): a CronJob provisioned by an OLDER os-ui keeps its old spec until somebody
// re-saves the schedule. The boot resync re-applies the current spec to every stored cron schedule
// and deletes os-ui's own schedule CronJobs that no stored schedule wants any more.

const NS_PATH = '/apis/batch/v1/namespaces/agentic-os/cronjobs';
const LIST_PATH = `${NS_PATH}?labelSelector=${encodeURIComponent('app.kubernetes.io/managed-by=os-ui,app.kubernetes.io/component=agent-schedule')}`;

/** A tiny in-memory API server for CronJobs: GET/PUT/POST/DELETE on one object, GET on the list. */
function fakeCluster(initial: Record<string, Record<string, unknown>>) {
  const objects = new Map(Object.entries(initial));
  const calls: string[] = [];
  let rv = 100;
  const client: CronK8s = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === LIST_PATH) return { status: 200, body: { items: [...objects.values()] } };
    const name = path.startsWith(`${NS_PATH}/`) ? path.slice(NS_PATH.length + 1) : null;
    if (method === 'POST' && path === NS_PATH) {
      const m = body as any;
      if (objects.has(m.metadata.name)) return { status: 409, body: {} };
      objects.set(m.metadata.name, { ...m, metadata: { ...m.metadata, resourceVersion: String(++rv) } });
      return { status: 201, body: {} };
    }
    if (!name) return { status: 400, body: {} };
    if (method === 'GET') return objects.has(name) ? { status: 200, body: objects.get(name)! } : { status: 404, body: {} };
    if (method === 'PUT') {
      const cur = objects.get(name) as any;
      const m = body as any;
      if (!cur) return { status: 404, body: {} };
      if (m.metadata.resourceVersion !== cur.metadata.resourceVersion) return { status: 409, body: {} };
      objects.set(name, { ...m, metadata: { ...m.metadata, resourceVersion: String(++rv) } });
      return { status: 200, body: {} };
    }
    if (method === 'DELETE') return objects.delete(name) ? { status: 200, body: {} } : { status: 404, body: {} };
    return { status: 405, body: {} };
  };
  return { client, objects, calls };
}

/** A CronJob as an OLD os-ui wrote it: the missing `os-ui` Secret, no pod labels. */
function oldCronJob(systemId: string, cron: string) {
  const m = buildCronJobManifest(systemId, cron, { ...OPTS, tokenSecret: 'os-ui', tokenSecretKey: 'agent-runtime-token' }) as any;
  delete m.spec.jobTemplate.spec.template.metadata;
  m.metadata.resourceVersion = '7';
  return m;
}
const tokenRef = (o: any) => o.spec.jobTemplate.spec.template.spec.containers[0].env.find((e: any) => e.name === 'RUNTIME_TOKEN').valueFrom.secretKeyRef;

test('RESYNC: a CronJob from an older os-ui is rewritten to the current spec (the real Secret, the label)', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const out = await resyncScheduleCrons(async () => [{ id: 'sys_a', schedule: { kind: 'cron', cron: '0 8 * * *' }, archived: false }], { ...OPTS, k8s: k.client });
  assert.equal(out.ok, true);
  assert.equal(out.applied, 1);
  assert.equal(out.deleted, 0);
  const now = k.objects.get('agent-schedule-sys-a') as any;
  assert.deepEqual(tokenRef(now), { name: 'agent-runtime-token', key: 'token' });
  assert.equal(now.spec.jobTemplate.spec.template.metadata.labels['app.kubernetes.io/component'], 'agent-schedule');
  assert.equal(now.spec.schedule, '0 8 * * *', 'the stored cron is kept');
});

test('RESYNC: a missing CronJob for a stored cron schedule is created', async () => {
  const k = fakeCluster({});
  const out = await resyncScheduleCrons(async () => [{ id: 'sys_b', schedule: { kind: 'cron', cron: '*/5 * * * *' }, archived: false }], { ...OPTS, k8s: k.client });
  assert.equal(out.applied, 1);
  assert.ok(k.objects.has('agent-schedule-sys-b'));
});

test('RESYNC: orphans are deleted — no system, a manual schedule, an archived system', async () => {
  const k = fakeCluster({
    'agent-schedule-sys-gone': oldCronJob('sys_gone', '0 8 * * *'),
    'agent-schedule-sys-manual': oldCronJob('sys_manual', '0 8 * * *'),
    'agent-schedule-sys-archived': oldCronJob('sys_archived', '0 8 * * *'),
    'agent-schedule-sys-keep': oldCronJob('sys_keep', '0 9 * * *'),
  });
  const out = await resyncScheduleCrons(async () => [
    { id: 'sys_manual', schedule: { kind: 'manual' }, archived: false },
    { id: 'sys_archived', schedule: { kind: 'cron', cron: '0 8 * * *' }, archived: true },
    { id: 'sys_keep', schedule: { kind: 'cron', cron: '0 9 * * *' }, archived: false },
  ], { ...OPTS, k8s: k.client });
  assert.equal(out.ok, true);
  assert.equal(out.deleted, 3);
  assert.deepEqual([...k.objects.keys()], ['agent-schedule-sys-keep']);
});

test('RESYNC: idempotent — a second pass (or a second pod during a rolling update) changes nothing it should not', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const systems = async () => [{ id: 'sys_a', schedule: { kind: 'cron' as const, cron: '0 8 * * *' }, archived: false }];
  const [one, two] = await Promise.all([
    resyncScheduleCrons(systems, { ...OPTS, k8s: k.client }),
    resyncScheduleCrons(systems, { ...OPTS, k8s: k.client }),
  ]);
  const again = await resyncScheduleCrons(systems, { ...OPTS, k8s: k.client });
  assert.equal(again.ok, true, 'a later pass is clean');
  assert.equal(k.objects.size, 1, 'never a duplicate');
  assert.deepEqual(tokenRef(k.objects.get('agent-schedule-sys-a')), { name: 'agent-runtime-token', key: 'token' });
  assert.ok(one.applied + two.applied >= 1, 'at least one concurrent pass applied it');
});

test('RESYNC: an unreadable registry (null) touches NOTHING — an empty store is not a fact', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const out = await resyncScheduleCrons(async () => null, { ...OPTS, k8s: k.client });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? '', /registry/);
  assert.equal(k.calls.length, 0);
  assert.ok(k.objects.has('agent-schedule-sys-a'));
});

test('RESYNC: a schedule saved DURING the pass is not deleted as an orphan (the registry is re-read before deleting)', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-new': oldCronJob('sys_new', '0 8 * * *') });
  let reads = 0;
  const out = await resyncScheduleCrons(async () => {
    reads += 1;
    return reads === 1 ? [] : [{ id: 'sys_new', schedule: { kind: 'cron', cron: '0 8 * * *' }, archived: false }];
  }, { ...OPTS, k8s: k.client });
  assert.equal(out.deleted, 0);
  assert.ok(k.objects.has('agent-schedule-sys-new'));
});

test('BOOT: the resync retries until one pass is clean, logs one line per pass with the counts, then stops', async () => {
  const results = [
    { ok: false, reason: 'the agent registry is not readable yet — nothing changed', desired: 0, applied: 0, deleted: 0, failed: 0 },
    { ok: true, desired: 2, applied: 2, deleted: 1, failed: 0 },
  ];
  let passes = 0;
  const lines: string[] = [];
  let timerTick: (() => Promise<unknown>) | undefined;
  let stopped = false;
  await scheduleBootCronResync(async () => results[Math.min(passes++, 1)], {
    every: (_n, _ms, fn) => { timerTick = fn; return () => { stopped = true; }; },
    log: (l) => lines.push(l),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /incomplete/);
  assert.equal(stopped, false, 'an incomplete pass keeps the retry timer');
  await timerTick!();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /done — desired 2, applied 2, orphans deleted 1, failed 0/);
  assert.equal(stopped, true, 'a clean pass stops the timer');
  await timerTick!();
  assert.equal(passes, 2, 'nothing runs after the clean pass');
});

test('BOOT: no API server (a laptop) — the resync gives up after maxPasses instead of logging forever', async () => {
  const lines: string[] = [];
  let timerTick: (() => Promise<unknown>) | undefined;
  let stopped = false;
  await scheduleBootCronResync(async () => ({ ok: false, desired: 0, applied: 0, deleted: 0, failed: 1 }), {
    maxPasses: 2,
    every: (_n, _ms, fn) => { timerTick = fn; return () => { stopped = true; }; },
    log: (l) => lines.push(l),
  });
  await timerTick!();
  assert.equal(stopped, true);
  assert.match(lines.at(-1)!, /giving up after 2 passes/);
});

test('RESYNC: an unreachable API server is reported, never claimed done', async () => {
  const out = await resyncScheduleCrons(async () => [{ id: 'sys_a', schedule: { kind: 'cron', cron: '0 8 * * *' }, archived: false }], { ...OPTS, k8s: async () => ({ status: 0, body: {} }) });
  assert.equal(out.ok, false);
  assert.equal(out.applied, 0);
  assert.ok(out.failed >= 1);
  assert.equal(out.deleted, 0);
});
