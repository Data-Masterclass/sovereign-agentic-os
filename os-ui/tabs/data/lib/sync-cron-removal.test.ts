/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The CronJob cleanup that survived B4's deletion of the OS-side scheduler
 * USER STORY: As an operator upgrading into the Dagster world I want the per-dataset CronJob a
 *             pre-B2 save left behind to be deleted, and I want the OS to say honestly when it
 *             could not check — never to claim a CronJob is gone on an unreachable cluster.
 * ARCHITECTURE:
 *   - Pure HTTP-shape assertions against an injected k8s client: no cluster, no fixtures.
 *   - It also asserts what is NOT there any more: this module has no way to CREATE a CronJob
 *     (checklist D7 — `sync-cron.ts` and its manifest builder are deleted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as removal from '@tabs/data/lib/sync-cron-removal';
import { removeSyncCronJob, syncCronJobName } from '@tabs/data/lib/sync-cron-removal';

type Call = { method: string; path: string };

function client(status: number): { k8s: removal.CronK8s; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    k8s: async (method, path) => {
      calls.push({ method, path });
      return { status, body: {} };
    },
  };
}

test('the name is deterministic and RFC1123-safe — it addresses exactly the objects a pre-B2 save created', () => {
  assert.equal(syncCronJobName('ds_ab12cd'), 'data-sync-ds-ab12cd');
  assert.equal(syncCronJobName('DS_Ab.12'), 'data-sync-ds-ab-12');
  assert.equal(syncCronJobName(''), 'data-sync-dataset');
  assert.ok(syncCronJobName('x'.repeat(80)).length <= 52);
  assert.doesNotMatch(syncCronJobName('ds_trailing___'), /-$/);
});

test('a deleted CronJob is reported as deleted, and the request is a DELETE on the named object', async () => {
  const { k8s, calls } = client(200);
  const out = await removeSyncCronJob('ds_ab12cd', { k8s, namespace: 'agentic-os' });
  assert.deepEqual(out, {
    ok: true,
    live: true,
    action: 'deleted',
    name: 'data-sync-ds-ab12cd',
    detail: 'Deleted the pre-B2 sync CronJob data-sync-ds-ab12cd.',
  });
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/apis/batch/v1/namespaces/agentic-os/cronjobs/data-sync-ds-ab12cd' }]);
});

test('a 404 is a benign no-op (idempotent — the normal case on an install that never had one)', async () => {
  const { k8s } = client(404);
  const out = await removeSyncCronJob('ds_ab12cd', { k8s, namespace: 'agentic-os' });
  assert.equal(out.ok, true);
  assert.equal(out.action, 'noop');
  assert.equal(out.detail, 'No sync CronJob to remove.');
});

test('an unreachable API server is live:false with the reason — never a claim', async () => {
  const { k8s } = client(0);
  const out = await removeSyncCronJob('ds_ab12cd', { k8s, namespace: 'agentic-os' });
  assert.equal(out.ok, false);
  assert.equal(out.live, false);
  assert.match(out.detail, /Kubernetes API unreachable/);
  assert.match(out.detail, /removed on the next save/);
});

test('a rejected deletion reports the status, and nothing throws', async () => {
  const { k8s } = client(403);
  const out = await removeSyncCronJob('ds_ab12cd', { k8s, namespace: 'agentic-os' });
  assert.equal(out.ok, false);
  assert.match(out.detail, /HTTP 403/);
});

test('D7: nothing here can CREATE a CronJob — the provisioning path is gone', () => {
  const exported = Object.keys(removal).sort();
  assert.deepEqual(exported, ['removeSyncCronJob', 'syncCronJobName']);
  for (const name of exported) {
    assert.doesNotMatch(name, /reconcile|build|upsert|create/i, `${name} suggests a write path that must not exist`);
  }
});
