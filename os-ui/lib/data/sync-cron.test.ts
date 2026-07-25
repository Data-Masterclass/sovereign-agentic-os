/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncCronJobName,
  buildSyncCronJobManifest,
  reconcileSyncCron,
  cronDueInWindow,
  type CronK8s,
} from './sync-cron.ts';

const OPTS = {
  namespace: 'agentic-os',
  urlBase: 'http://os-ui:3000/api/data/datasets',
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

test('syncCronJobName is deterministic + RFC1123-safe', () => {
  assert.equal(syncCronJobName('ds_ab12cd34'), 'data-sync-ds-ab12cd34');
  assert.match(syncCronJobName('ds_ab12cd34'), /^[a-z0-9-]+$/);
});

test('manifest: UTC timezone, tight starting deadline, Forbid, bearer from a Secret', () => {
  const m = buildSyncCronJobManifest('ds_x1', '0 6 * * *', OPTS) as any;
  assert.equal(m.kind, 'CronJob');
  assert.equal(m.spec.schedule, '0 6 * * *');
  assert.equal(m.spec.timeZone, 'UTC');
  assert.equal(m.spec.startingDeadlineSeconds, 60);
  assert.equal(m.spec.concurrencyPolicy, 'Forbid');
  const container = m.spec.jobTemplate.spec.template.spec.containers[0];
  const tokenEnv = container.env.find((e: any) => e.name === 'RUNTIME_TOKEN');
  assert.ok(tokenEnv.valueFrom.secretKeyRef, 'token comes from a secretKeyRef, not a literal value');
  const urlEnv = container.env.find((e: any) => e.name === 'TARGET_URL');
  assert.equal(urlEnv.value, 'http://os-ui:3000/api/data/datasets/ds_x1/sync');
});

test('enabled sync CREATES a CronJob when none exists (GET 404 → POST 201)', async () => {
  const { client, calls } = mockK8s({
    'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/data-sync-ds-1': { status: 404 },
    'POST /apis/batch/v1/namespaces/agentic-os/cronjobs': { status: 201 },
  });
  const out = await reconcileSyncCron('ds_1', { enabled: true, schedule: { cron: '0 6 * * *' } }, { ...OPTS, k8s: client });
  assert.deepEqual([out.ok, out.live, out.action], [true, true, 'created']);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST']);
});

test('re-save UPDATES idempotently, carrying the resourceVersion', async () => {
  const { client, calls } = mockK8s({
    'GET /apis/batch/v1/namespaces/agentic-os/cronjobs/data-sync-ds-1': { status: 200, body: { metadata: { resourceVersion: '77' } } },
    'PUT /apis/batch/v1/namespaces/agentic-os/cronjobs/data-sync-ds-1': { status: 200 },
  });
  const out = await reconcileSyncCron('ds_1', { enabled: true, schedule: { cron: '*/30 * * * *' } }, { ...OPTS, k8s: client });
  assert.equal(out.action, 'updated');
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(((put.body as any).metadata).resourceVersion, '77');
});

test('disabled / cleared sync DELETES the CronJob (404 is a benign no-op)', async () => {
  const del = mockK8s({ 'DELETE /apis/batch/v1/namespaces/agentic-os/cronjobs/data-sync-ds-1': { status: 200 } });
  const out1 = await reconcileSyncCron('ds_1', { enabled: false, schedule: { cron: '0 6 * * *' } }, { ...OPTS, k8s: del.client });
  assert.deepEqual([out1.ok, out1.action], [true, 'deleted']);

  const gone = mockK8s({ 'DELETE /apis/batch/v1/namespaces/agentic-os/cronjobs/data-sync-ds-1': { status: 404 } });
  const out2 = await reconcileSyncCron('ds_1', null, { ...OPTS, k8s: gone.client });
  assert.deepEqual([out2.ok, out2.action], [true, 'noop']);
});

test('unreachable cluster is reported HONESTLY (never claims the CronJob exists)', async () => {
  const { client } = mockK8s({}); // every call → status 0
  const out = await reconcileSyncCron('ds_1', { enabled: true, schedule: { cron: '0 6 * * *' } }, { ...OPTS, k8s: client });
  assert.deepEqual([out.ok, out.live], [false, false]);
  assert.match(out.detail, /unreachable/i);
});

test('invalid cron is refused before any cluster call', async () => {
  const { client, calls } = mockK8s({});
  const out = await reconcileSyncCron('ds_1', { enabled: true, schedule: { cron: 'whenever' } }, { ...OPTS, k8s: client });
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
});

// ----------------------------------------------------------- sweep due-matching --

const at = (iso: string) => new Date(iso);

test('cronDueInWindow: hourly/step/specific-time schedules', () => {
  // "0 * * * *" fires at 10:00 inside (09:58, 10:03].
  assert.ok(cronDueInWindow('0 * * * *', at('2026-07-25T09:58:00Z'), at('2026-07-25T10:03:00Z')));
  assert.ok(!cronDueInWindow('0 * * * *', at('2026-07-25T10:01:00Z'), at('2026-07-25T10:14:00Z')));
  // "*/15 * * * *" fires within any 15-minute window.
  assert.ok(cronDueInWindow('*/15 * * * *', at('2026-07-25T10:01:00Z'), at('2026-07-25T10:16:00Z')));
  // "30 6 * * *" (daily 06:30 UTC) fires only around that time.
  assert.ok(cronDueInWindow('30 6 * * *', at('2026-07-25T06:25:00Z'), at('2026-07-25T06:35:00Z')));
  assert.ok(!cronDueInWindow('30 6 * * *', at('2026-07-25T07:25:00Z'), at('2026-07-25T07:35:00Z')));
});

test('cronDueInWindow: weekly day-of-week + ranges', () => {
  // 2026-07-25 is a Saturday (UTC day 6). "0 9 * * 6" fires 09:00 Saturday.
  assert.ok(cronDueInWindow('0 9 * * 6', at('2026-07-25T08:55:00Z'), at('2026-07-25T09:05:00Z')));
  assert.ok(!cronDueInWindow('0 9 * * 1', at('2026-07-25T08:55:00Z'), at('2026-07-25T09:05:00Z')));
  assert.ok(cronDueInWindow('0 9 * * 1-6', at('2026-07-25T08:55:00Z'), at('2026-07-25T09:05:00Z')));
});

test('cronDueInWindow: unparseable fields match NOTHING (fail-closed)', () => {
  assert.ok(!cronDueInWindow('0 9 * * MON', at('2026-07-25T08:55:00Z'), at('2026-07-25T09:05:00Z')));
  assert.ok(!cronDueInWindow('not a cron', at('2026-07-25T08:55:00Z'), at('2026-07-25T09:05:00Z')));
});
