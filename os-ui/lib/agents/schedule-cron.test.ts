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
  type CronK8s,
} from './schedule-cron.ts';

const OPTS = {
  namespace: 'agentic-os',
  targetUrl: 'http://os-ui:3000/api/agents/scheduled-run',
  image: 'curlimages/curl:8.11.1',
  tokenSecret: 'os-ui',
  tokenSecretKey: 'agent-runtime-token',
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
