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
  massDeleteHeld,
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

// ---- 2026-11-26 (F1, review R-1/R-2/R-4): a CronJob provisioned by an OLDER os-ui keeps its old
// spec until somebody re-saves the schedule. The boot resync re-applies the current spec to every
// cron schedule in the mirror (read FRESH — never this pod's registry), and deletes os-ui's own
// schedule CronJobs that nothing wants, behind a mass-delete guard.

const NS_PATH = '/apis/batch/v1/namespaces/agentic-os/cronjobs';
const LIST_PATH = `${NS_PATH}?labelSelector=${encodeURIComponent('app.kubernetes.io/managed-by=os-ui,app.kubernetes.io/component=agent-schedule')}`;

/** A tiny in-memory API server for CronJobs: GET/PUT/POST/DELETE (with uid preconditions), list. */
function fakeCluster(initial: Record<string, Record<string, unknown>>, hooks: { putConflicts?: number; deleteStatus?: number } = {}) {
  const objects = new Map(Object.entries(initial));
  const calls: { method: string; path: string; body?: any }[] = [];
  let rv = 100;
  let putConflicts = hooks.putConflicts ?? 0;
  const client: CronK8s = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === LIST_PATH) return { status: 200, body: { items: [...objects.values()] } };
    const name = path.startsWith(`${NS_PATH}/`) ? path.slice(NS_PATH.length + 1) : null;
    if (method === 'POST' && path === NS_PATH) {
      const m = body as any;
      if (objects.has(m.metadata.name)) return { status: 409, body: {} };
      objects.set(m.metadata.name, { ...m, metadata: { ...m.metadata, resourceVersion: String(++rv), uid: `uid-${rv}` } });
      return { status: 201, body: {} };
    }
    if (!name) return { status: 400, body: {} };
    if (method === 'GET') return objects.has(name) ? { status: 200, body: objects.get(name)! } : { status: 404, body: {} };
    if (method === 'PUT') {
      const cur = objects.get(name) as any;
      const m = body as any;
      if (!cur) return { status: 404, body: {} };
      if (putConflicts > 0) {
        // Another writer replaced it between our GET and PUT: bump its resourceVersion.
        putConflicts -= 1;
        cur.metadata.resourceVersion = String(++rv);
        return { status: 409, body: {} };
      }
      if (m.metadata.resourceVersion !== cur.metadata.resourceVersion) return { status: 409, body: {} };
      objects.set(name, { ...m, metadata: { ...m.metadata, resourceVersion: String(++rv), uid: cur.metadata.uid } });
      return { status: 200, body: {} };
    }
    if (method === 'DELETE') {
      if (hooks.deleteStatus) return { status: hooks.deleteStatus, body: {} };
      const cur = objects.get(name) as any;
      if (!cur) return { status: 404, body: {} };
      const want = (body as any)?.preconditions?.uid;
      if (want && want !== cur.metadata.uid) return { status: 409, body: {} };
      objects.delete(name);
      return { status: 200, body: {} };
    }
    return { status: 405, body: {} };
  };
  return { client, objects, calls };
}

/** A CronJob as an OLD os-ui wrote it: the missing `os-ui` Secret, no pod labels. */
let uidSeq = 0;
function oldCronJob(systemId: string, cron: string) {
  const m = buildCronJobManifest(systemId, cron, { ...OPTS, tokenSecret: 'os-ui', tokenSecretKey: 'agent-runtime-token' }) as any;
  delete m.spec.jobTemplate.spec.template.metadata;
  m.metadata.resourceVersion = '7';
  m.metadata.uid = `old-${++uidSeq}`;
  return m;
}
const tokenRef = (o: any) => o.spec.jobTemplate.spec.template.spec.containers[0].env.find((e: any) => e.name === 'RUNTIME_TOKEN').valueFrom.secretKeyRef;

type Row = { id: string; schedule: { kind: 'cron'; cron: string } | { kind: 'manual' }; archived: boolean };
const cron = (id: string, c: string, archived = false): Row => ({ id, schedule: { kind: 'cron', cron: c }, archived });
/** A fresh mirror: `list` and `readOne` answer from the same rows (mutable between reads). */
function mirrorOf(rows: Row[]) {
  const m = { rows, lists: 0, reads: [] as string[] };
  const deps = {
    list: async () => { m.lists += 1; return m.rows.map((r) => ({ ...r })); },
    readOne: async (id: string) => {
      m.reads.push(id);
      const r = m.rows.find((x) => x.id === id);
      return r ? { state: 'found' as const, system: { ...r } } : { state: 'absent' as const };
    },
  };
  return { m, deps };
}

test('RESYNC: a CronJob from an older os-ui is rewritten to the current spec (the real Secret, the label)', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const out = await resyncScheduleCrons(mirrorOf([cron('sys_a', '0 8 * * *')]).deps, { ...OPTS, k8s: k.client });
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
  const out = await resyncScheduleCrons(mirrorOf([cron('sys_b', '*/5 * * * *')]).deps, { ...OPTS, k8s: k.client });
  assert.equal(out.applied, 1);
  assert.ok(k.objects.has('agent-schedule-sys-b'));
});

test('RESYNC: orphans are deleted — no system, a manual schedule, an archived system — with a uid precondition', async () => {
  const k = fakeCluster({
    'agent-schedule-sys-gone': oldCronJob('sys_gone', '0 8 * * *'),
    'agent-schedule-sys-archived': oldCronJob('sys_archived', '0 8 * * *'),
    'agent-schedule-sys-keep': oldCronJob('sys_keep', '0 9 * * *'),
    'agent-schedule-sys-keep2': oldCronJob('sys_keep2', '0 9 * * *'),
    'agent-schedule-sys-keep3': oldCronJob('sys_keep3', '0 9 * * *'),
  });
  const out = await resyncScheduleCrons(mirrorOf([
    cron('sys_archived', '0 8 * * *', true),
    cron('sys_keep', '0 9 * * *'), cron('sys_keep2', '0 9 * * *'), cron('sys_keep3', '0 9 * * *'),
  ]).deps, { ...OPTS, k8s: k.client });
  assert.equal(out.ok, true);
  assert.equal(out.deleted, 2);
  assert.deepEqual([...k.objects.keys()].sort(), ['agent-schedule-sys-keep', 'agent-schedule-sys-keep2', 'agent-schedule-sys-keep3']);
  const del = k.calls.filter((c) => c.method === 'DELETE');
  assert.ok(del.every((c) => typeof c.body?.preconditions?.uid === 'string'), 'every delete carries the listed uid');
});

test('RESYNC (R-4): a CronJob re-created between the list and the delete (another uid) is NOT deleted, and that is not a failure', async () => {
  const k = fakeCluster({
    'agent-schedule-sys-x': oldCronJob('sys_x', '0 8 * * *'),
    'agent-schedule-sys-k1': oldCronJob('sys_k1', '0 8 * * *'),
    'agent-schedule-sys-k2': oldCronJob('sys_k2', '0 8 * * *'),
  });
  const { deps } = mirrorOf([cron('sys_k1', '0 8 * * *'), cron('sys_k2', '0 8 * * *')]);
  const client: CronK8s = async (method, path, body) => {
    if (method === 'DELETE') (k.objects.get('agent-schedule-sys-x') as any).metadata.uid = 'recreated';
    return k.client(method, path, body);
  };
  const out = await resyncScheduleCrons(deps, { ...OPTS, k8s: client });
  assert.equal(out.ok, true);
  assert.ok(k.objects.has('agent-schedule-sys-x'), 'the uid precondition protected the new object');
});

test('RESYNC (R-4): a 404 on DELETE (already gone) counts as success', async () => {
  const k = fakeCluster({
    'agent-schedule-sys-gone': oldCronJob('sys_gone', '0 8 * * *'),
    'agent-schedule-sys-k1': oldCronJob('sys_k1', '0 8 * * *'),
    'agent-schedule-sys-k2': oldCronJob('sys_k2', '0 8 * * *'),
  }, { deleteStatus: 404 });
  const out = await resyncScheduleCrons(mirrorOf([cron('sys_k1', '0 8 * * *'), cron('sys_k2', '0 8 * * *')]).deps, { ...OPTS, k8s: k.client });
  assert.equal(out.ok, true);
  assert.equal(out.deleted, 1);
  assert.equal(out.failed, 0);
});

test('RESYNC (R-4): a 409 on PUT (a concurrent writer) is re-read once and the same spec applied', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') }, { putConflicts: 1 });
  const out = await resyncScheduleCrons(mirrorOf([cron('sys_a', '0 8 * * *')]).deps, { ...OPTS, k8s: k.client });
  assert.equal(out.ok, true);
  assert.equal(out.applied, 1);
  const methods = k.calls.filter((c) => c.path.endsWith('/agent-schedule-sys-a')).map((c) => c.method);
  assert.deepEqual(methods, ['GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(tokenRef(k.objects.get('agent-schedule-sys-a')), { name: 'agent-runtime-token', key: 'token' });
});

test('RESYNC: idempotent — two passes at once (a rolling update) and a third one leave one correct CronJob', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const { deps } = mirrorOf([cron('sys_a', '0 8 * * *')]);
  await Promise.all([resyncScheduleCrons(deps, { ...OPTS, k8s: k.client }), resyncScheduleCrons(deps, { ...OPTS, k8s: k.client })]);
  const again = await resyncScheduleCrons(deps, { ...OPTS, k8s: k.client });
  assert.equal(again.ok, true);
  assert.equal(k.objects.size, 1);
  assert.deepEqual(tokenRef(k.objects.get('agent-schedule-sys-a')), { name: 'agent-runtime-token', key: 'token' });
});

test('RESYNC (R-1): a partial / unreadable mirror read (null) touches NOTHING', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const out = await resyncScheduleCrons({ list: async () => null, readOne: async () => ({ state: 'unreachable' }) }, { ...OPTS, k8s: k.client });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? '', /could not be read completely/);
  assert.equal(k.calls.length, 0);
});

test('RESYNC (R-1): a schedule cleared on another pod after the list is NOT resurrected (re-read before the write)', async () => {
  const k = fakeCluster({});
  const { m, deps } = mirrorOf([cron('sys_a', '0 8 * * *')]);
  const out = await resyncScheduleCrons({ list: async () => { const r = await deps.list(); m.rows = [{ id: 'sys_a', schedule: { kind: 'manual' }, archived: false }]; return r; }, readOne: deps.readOne }, { ...OPTS, k8s: k.client });
  assert.equal(out.skipped, 1);
  assert.equal(out.applied, 0);
  assert.equal(k.objects.size, 0, 'no CronJob was created for a cleared schedule');
});

test('RESYNC (R-1): a cron edited on another pod after the list is written with the NEW cron (never reverted)', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const { m, deps } = mirrorOf([cron('sys_a', '0 8 * * *')]);
  await resyncScheduleCrons({ list: async () => { const r = await deps.list(); m.rows = [cron('sys_a', '30 6 * * 1')]; return r; }, readOne: deps.readOne }, { ...OPTS, k8s: k.client });
  assert.equal((k.objects.get('agent-schedule-sys-a') as any).spec.schedule, '30 6 * * 1');
});

test('RESYNC (R-1): a schedule saved on another pod during the pass is not deleted as an orphan (second fresh read)', async () => {
  const k = fakeCluster({
    'agent-schedule-sys-new': oldCronJob('sys_new', '0 8 * * *'),
    'agent-schedule-sys-k1': oldCronJob('sys_k1', '0 8 * * *'),
    'agent-schedule-sys-k2': oldCronJob('sys_k2', '0 8 * * *'),
  });
  const { m, deps } = mirrorOf([cron('sys_k1', '0 8 * * *'), cron('sys_k2', '0 8 * * *')]);
  const out = await resyncScheduleCrons({
    list: async () => { const r = await deps.list(); if (m.lists === 1) m.rows = [...m.rows, cron('sys_new', '0 8 * * *')]; return r; },
    readOne: deps.readOne,
  }, { ...OPTS, k8s: k.client });
  assert.equal(out.deleted, 0);
  assert.ok(k.objects.has('agent-schedule-sys-new'));
});

test('MASS-DELETE GUARD (R-2): no desired schedule while CronJobs exist → nothing deleted, said loudly', async () => {
  const k = fakeCluster({ 'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *') });
  const out = await resyncScheduleCrons(mirrorOf([]).deps, { ...OPTS, k8s: k.client });
  assert.equal(out.ok, false);
  assert.equal(out.deletesHeld, true);
  assert.equal(out.deleted, 0);
  assert.ok(k.objects.has('agent-schedule-sys-a'));
});

test('MASS-DELETE GUARD (R-2): more than half of more than two listed would go → nothing deleted', async () => {
  const k = fakeCluster({
    'agent-schedule-sys-a': oldCronJob('sys_a', '0 8 * * *'),
    'agent-schedule-sys-b': oldCronJob('sys_b', '0 8 * * *'),
    'agent-schedule-sys-c': oldCronJob('sys_c', '0 8 * * *'),
  });
  const out = await resyncScheduleCrons(mirrorOf([cron('sys_a', '0 8 * * *')]).deps, { ...OPTS, k8s: k.client });
  assert.equal(out.deletesHeld, true);
  assert.equal(k.objects.size, 3);
});

test('MASS-DELETE GUARD (R-2): the thresholds', () => {
  assert.equal(massDeleteHeld(3, 4, 0), null);
  assert.match(massDeleteHeld(0, 1, 1) ?? '', /wants NO schedule/);
  assert.equal(massDeleteHeld(1, 2, 1), null, 'two listed: one orphan is allowed');
  assert.equal(massDeleteHeld(2, 4, 2), null, 'exactly half is allowed');
  assert.match(massDeleteHeld(1, 4, 3) ?? '', /more than half/);
});

/** A controllable timer pair for the boot scheduler. */
function timers() {
  const t = { delayed: undefined as (() => void) | undefined, delayMs: -1, tick: undefined as (() => Promise<unknown>) | undefined, stopped: false };
  return {
    t,
    every: (_n: string, _ms: number, fn: () => Promise<unknown>) => { t.tick = fn; return () => { t.stopped = true; }; },
    after: (ms: number, fn: () => void) => { t.delayMs = ms; t.delayed = fn; },
  };
}

test('BOOT: the first pass waits ~3 minutes, retries until clean, logs one line per pass, then stops', async () => {
  const results = [
    { ok: false, reason: 'x', desired: 0, applied: 0, deleted: 0, failed: 0, skipped: 0 },
    { ok: true, desired: 2, applied: 2, deleted: 1, failed: 0, skipped: 0 },
  ];
  let passes = 0;
  const lines: string[] = [];
  const { t, every, after } = timers();
  const { firstPass } = scheduleBootCronResync(async () => results[Math.min(passes++, 1)], { every, after, log: (l) => lines.push(l) });
  assert.equal(t.delayMs, 180_000, 'nothing runs at boot itself');
  assert.equal(passes, 0);
  t.delayed!();
  await firstPass;
  assert.equal(lines.length, 1);
  assert.match(lines[0], /incomplete/);
  assert.equal(t.stopped, false);
  await t.tick!();
  assert.match(lines[1], /done — desired 2, applied 2, skipped 0, orphans deleted 1, failed 0/);
  assert.equal(t.stopped, true);
  await t.tick!();
  assert.equal(passes, 2, 'nothing runs after the clean pass');
});

test('BOOT (R-4): the first pass and the interval never overlap (one shared in-flight flag)', async () => {
  let running = 0;
  let maxRunning = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { t, every, after } = timers();
  const { firstPass } = scheduleBootCronResync(async () => {
    running += 1; maxRunning = Math.max(maxRunning, running);
    await gate;
    running -= 1;
    return { ok: false, desired: 0, applied: 0, deleted: 0, failed: 1, skipped: 0 };
  }, { every, after, log: () => {} });
  t.delayed!();
  const overlapping = t.tick!(); // the interval fires while the first pass is still in flight
  release();
  await Promise.all([firstPass, overlapping]);
  assert.equal(maxRunning, 1);
});

test('BOOT: no API server (a laptop) — the resync gives up after maxPasses instead of logging forever', async () => {
  const lines: string[] = [];
  const { t, every, after } = timers();
  const { firstPass } = scheduleBootCronResync(async () => ({ ok: false, desired: 0, applied: 0, deleted: 0, failed: 1, skipped: 0 }), { maxPasses: 2, every, after, log: (l) => lines.push(l) });
  t.delayed!();
  await firstPass;
  await t.tick!();
  assert.equal(t.stopped, true);
  assert.match(lines.at(-1)!, /giving up after 2 passes/);
});

test('RESYNC: an unreachable API server is reported, never claimed done', async () => {
  const out = await resyncScheduleCrons(mirrorOf([cron('sys_a', '0 8 * * *')]).deps, { ...OPTS, k8s: async () => ({ status: 0, body: {} }) });
  assert.equal(out.ok, false);
  assert.equal(out.applied, 0);
  assert.ok(out.failed >= 1);
  assert.equal(out.deleted, 0);
});

test('the trigger runs curl without a shell and Kubernetes fills $(VAR) from env', async () => {
  const { buildCronJobManifest, scheduleCurlArgs, SCHEDULE_SOURCE_HEADER, SCHEDULE_CRON_HEADER } = await import('./schedule-cron.ts');
  const args = scheduleCurlArgs();
  assert.equal(args[0], 'curl');
  assert.ok(!args.includes('/bin/sh') && !args.includes('-c'), 'no shell');
  assert.ok(args.includes(`${SCHEDULE_SOURCE_HEADER}: os-ui`));
  assert.ok(args.includes(`${SCHEDULE_CRON_HEADER}: $(SCHEDULE_CRON)`));
  assert.ok(args.includes('Authorization: Bearer $(RUNTIME_TOKEN)'));
  assert.deepEqual(args.slice(-3), ['-d', '$(PAYLOAD)', '$(TARGET_URL)']);
  const man = buildCronJobManifest('sys_x', '0 8 * * *', {
    namespace: 'agentic-os', targetUrl: 'http://os-ui:3000/api/agents/scheduled-run',
    image: 'curlimages/curl:8.11.1', tokenSecret: 's', tokenSecretKey: 'token',
  }) as any;
  const c = man.spec.jobTemplate.spec.template.spec.containers[0];
  assert.deepEqual(c.command, args);
  const envNames = new Set(c.env.map((e: { name: string }) => e.name));
  for (const v of ['RUNTIME_TOKEN', 'SCHEDULE_CRON', 'PAYLOAD', 'TARGET_URL']) assert.ok(envNames.has(v), `env ${v} defined for $(${v})`);
});

test('the bearer env comes last so no other env value can expand it', async () => {
  const { buildCronJobManifest } = await import('./schedule-cron.ts');
  const man = buildCronJobManifest('sys_$(RUNTIME_TOKEN)', '0 8 * * *', {
    namespace: 'agentic-os', targetUrl: 'http://os-ui:3000/api/agents/scheduled-run',
    image: 'curlimages/curl:8.11.1', tokenSecret: 's', tokenSecretKey: 'token',
  }) as any;
  const env = man.spec.jobTemplate.spec.template.spec.containers[0].env;
  assert.equal(env[env.length - 1].name, 'RUNTIME_TOKEN');
});
