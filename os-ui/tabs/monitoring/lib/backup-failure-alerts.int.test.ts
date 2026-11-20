/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Backup failure alerts on REAL components (WP-05).
 * USER STORY: As a platform admin I want proof, on the real tools, that a failed backup alerts.
 * ARCHITECTURE:
 *   - OpenSearch (BACKUP_OS_IT=1, tests/observability/health-up.sh, the chart's OpenSearch env): a real PARTIAL
 *     snapshot — an index whose primary cannot be allocated, snapshotted with `partial: true` —
 *     read through the live reader (`_cat/snapshots`, the one OpenSearch client) ⇒ critical. Twin:
 *     a newer SUCCESS snapshot ⇒ no alert. A repository that does not exist ⇒ warning.
 *   - Kubernetes (BACKUP_K8S_IT=1, KUBE_CONTEXT, a kind cluster): a CronJob whose Job really fails
 *     (exit 1, backoffLimit 0) and one whose Job succeeds; the JobList the API server returns is
 *     fed to the live reader ⇒ exactly one critical alert, for the failing one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { backupFailureAlerts } from '@tabs/monitoring/lib/backup-failure-alerts-core';
import { readCronJobs, readSnapshots } from '@tabs/monitoring/lib/adapters/backup-failures';
import { opensearchFetch } from '@core/adapters/opensearch/client';

// Setup goes through the ONE OpenSearch client too (its URL comes from the chart's env).
const os = async (method: string, path: string, body?: unknown) => {
  const r = await opensearchFetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('OpenSearch: a real PARTIAL snapshot raises a critical alert; a newer SUCCESS clears it', { skip: process.env.BACKUP_OS_IT !== '1' }, async () => {
  const repo = 'wp05-it';
  let r = await os('PUT', `/_snapshot/${repo}`, { type: 'fs', settings: { location: '/tmp/os-snap/wp05' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await os('DELETE', '/wp05-*');
  r = await os('PUT', '/wp05-ok', { settings: { number_of_replicas: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await os('POST', '/wp05-ok/_doc?refresh=true', { n: 1 });
  // A primary that can never be allocated: the index is red, so a partial snapshot is PARTIAL.
  r = await os('PUT', '/wp05-red?wait_for_active_shards=0', { settings: { number_of_replicas: 0, 'index.routing.allocation.require._name': 'no-such-node' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await os('PUT', `/_snapshot/${repo}/bad-1?wait_for_completion=true`, { indices: 'wp05-*', partial: true, include_global_state: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.snapshot.state, 'PARTIAL', 'OpenSearch itself reports the snapshot PARTIAL');

  let alerts = backupFailureAlerts({ cronJobs: [], velero: null, snapshotRepos: await readSnapshots([repo]) });
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.equal(alerts[0].severity, 'critical');
  assert.match(alerts[0].title, /OpenSearch snapshot PARTIAL: wp05-it/);

  await new Promise((res) => setTimeout(res, 1100)); // end_epoch has second resolution
  r = await os('PUT', `/_snapshot/${repo}/good-2?wait_for_completion=true`, { indices: 'wp05-ok', include_global_state: false });
  assert.equal(r.body.snapshot.state, 'SUCCESS');
  alerts = backupFailureAlerts({ cronJobs: [], velero: null, snapshotRepos: await readSnapshots([repo]) });
  assert.deepEqual(alerts, [], 'the newest finished snapshot succeeded');

  const missing = backupFailureAlerts({ cronJobs: [], velero: null, snapshotRepos: await readSnapshots(['no-such-repo']) });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'warning');
  await os('DELETE', '/wp05-*');
});

test('Kubernetes: a CronJob whose newest Job really failed raises one critical alert; a succeeding one none', { skip: process.env.BACKUP_K8S_IT !== '1' }, async () => {
  const ctx = process.env.KUBE_CONTEXT ?? 'kind-wp05';
  const ns = 'backup-alerts-it';
  const k = (...a: string[]) => execFileSync('kubectl', ['--context', ctx, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  try { k('create', 'namespace', ns); } catch { /* exists */ }
  const cron = (name: string, code: number) => ({
    apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name, namespace: ns },
    spec: { schedule: '0 0 1 1 *', suspend: true, jobTemplate: { spec: { backoffLimit: 0, template: { spec: { restartPolicy: 'Never',
      containers: [{ name: 'c', image: 'busybox:1.37', command: ['sh', '-c', `exit ${code}`] }] } } } } },
  });
  for (const [name, code] of [['pg-dump', 1], ['opensearch-snapshot', 0]] as const) {
    execFileSync('kubectl', ['--context', ctx, 'apply', '-f', '-'], { input: JSON.stringify(cron(name, code)) });
    k('-n', ns, 'create', 'job', `${name}-run-1`, `--from=cronjob/${name}`);
  }
  k('-n', ns, 'wait', '--for=condition=Failed', 'job/pg-dump-run-1', '--timeout=180s');
  k('-n', ns, 'wait', '--for=condition=Complete', 'job/opensearch-snapshot-run-1', '--timeout=180s');
  const list = JSON.parse(k('get', '--raw', `/apis/batch/v1/namespaces/${ns}/jobs`));
  const get = (async (_m: string, path: string) => {
    assert.equal(path, `/apis/batch/v1/namespaces/${ns}/jobs`);
    return { status: 200, body: list };
  }) as never;
  const alerts = backupFailureAlerts({ cronJobs: await readCronJobs(['pg-dump', 'opensearch-snapshot'], ns, get), velero: null, snapshotRepos: [] });
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.equal(alerts[0].severity, 'critical');
  assert.match(alerts[0].title, /Backup job failed: pg-dump/);
  assert.match(alerts[0].detail, /BackoffLimitExceeded/);
  k('delete', 'namespace', ns, '--wait=false');
});
