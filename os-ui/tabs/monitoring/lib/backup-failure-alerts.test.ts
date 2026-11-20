/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A failed nightly backup raises a critical alert, read from each tool (WP-05).
 * USER STORY: As a platform admin I want a failed pg-dump, Velero backup or OpenSearch snapshot to
 *             alert me, and an unreadable source to say so — never silence, never an age guess.
 * ARCHITECTURE:
 *   - The payloads are the tools' own shapes (batch/v1 JobList, velero.io/v1 BackupList — field
 *     sets as read live, read-only, on 2026-11-20 — and OpenSearch `_cat/snapshots?format=json`).
 *   - The readers get injected transports, so the request paths are asserted too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupFailureAlerts } from '@tabs/monitoring/lib/backup-failure-alerts-core';
import { parseJobs, parseSnapshots, parseVeleroBackups } from '@core/infra/backup-sources-parse';
import { readCronJobs, readSnapshots, readVelero } from '@tabs/monitoring/lib/adapters/backup-failures';

const job = (name: string, owner: string | null, created: string, cond: 'Complete' | 'Failed' | null, reason = 'BackoffLimitExceeded') => ({
  metadata: { name, creationTimestamp: created, ownerReferences: owner ? [{ apiVersion: 'batch/v1', kind: 'CronJob', name: owner, controller: true }] : [] },
  status: { conditions: cond === 'Complete'
    ? [{ type: 'SuccessCriteriaMet', status: 'True', reason: 'CompletionsReached' }, { type: 'Complete', status: 'True', reason: 'CompletionsReached' }]
    : cond === 'Failed' ? [{ type: 'FailureTarget', status: 'True', reason }, { type: 'Failed', status: 'True', reason, message: 'Job has reached the specified backoff limit' }] : [] },
});
const backup = (name: string, created: string, phase: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name, creationTimestamp: created, labels: { 'velero.io/schedule-name': 'velero-daily-agentic-os' } },
  status: { phase, startTimestamp: created, version: 1, formatVersion: '1.1.0', ...extra },
});
const k8sAnswer = (body: unknown, status = 200, seen: string[] = []) =>
  (async (_m: string, path: string) => { seen.push(path); return { status, body: body as Record<string, unknown> }; }) as never;

test('a failed newest pg-dump Job raises ONE critical alert; an older failure followed by success raises none', async () => {
  const seen: string[] = [];
  const failedNow = { items: [job('pg-dump-29919000', 'pg-dump', '2026-11-19T02:30:00Z', 'Complete'), job('pg-dump-29920440', 'pg-dump', '2026-11-20T02:30:00Z', 'Failed')] };
  const c = await readCronJobs(['pg-dump'], 'agentic-os', k8sAnswer(failedNow, 200, seen));
  assert.deepEqual(seen, ['/apis/batch/v1/namespaces/agentic-os/jobs']);
  const a = backupFailureAlerts({ cronJobs: c, velero: null, snapshotRepos: [] });
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'critical');
  assert.match(a[0].title, /Backup job failed: pg-dump/);
  assert.match(a[0].detail, /pg-dump-29920440.*BackoffLimitExceeded/);
  // Twin: recovered — the newest FINISHED run succeeded.
  const recovered = { items: [job('pg-dump-1', 'pg-dump', '2026-11-19T02:30:00Z', 'Failed'), job('pg-dump-2', 'pg-dump', '2026-11-20T02:30:00Z', 'Complete'), job('pg-dump-3', 'pg-dump', '2026-11-20T09:00:00Z', null)] };
  assert.deepEqual(backupFailureAlerts({ cronJobs: await readCronJobs(['pg-dump'], 'agentic-os', k8sAnswer(recovered)), velero: null, snapshotRepos: [] }), []);
});

test('only Jobs OWNED by the CronJob count (a failed unrelated Job is not a backup failure)', () => {
  const body = { items: [job('random', null, '2026-11-20T05:00:00Z', 'Failed'), job('opensearch-snapshot-9', 'opensearch-snapshot', '2026-11-20T03:00:00Z', 'Failed', 'DeadlineExceeded')] };
  assert.equal(parseJobs(body, 'pg-dump').length, 0);
  const a = backupFailureAlerts({ cronJobs: [{ cronJob: 'opensearch-snapshot', jobs: parseJobs(body, 'opensearch-snapshot') }], velero: null, snapshotRepos: [] });
  assert.equal(a.length, 1);
  assert.match(a[0].detail, /DeadlineExceeded/);
});

test('NEGATIVE: an unreadable source is a warning alert, never silence', async () => {
  const c = await readCronJobs(['pg-dump', 'opensearch-snapshot'], 'agentic-os', k8sAnswer({}, 403));
  const v = await readVelero('velero', 'velero-daily-agentic-os', k8sAnswer({}, 0));
  const s = await readSnapshots(['stackit-s3'], async () => null);
  const a = backupFailureAlerts({ cronJobs: c, velero: v, snapshotRepos: s });
  assert.equal(a.length, 4);
  assert.ok(a.every((x) => x.severity === 'warning' && /unreadable/.test(x.title)), JSON.stringify(a));
});

test('Velero: the Schedule\'s newest FINISHED backup decides; PartiallyFailed / Failed are critical', async () => {
  const seen: string[] = [];
  const body = { items: [
    backup('velero-daily-agentic-os-20261119030021', '2026-11-19T03:00:21Z', 'Completed', { warnings: 1 }),
    backup('velero-daily-agentic-os-20261120030023', '2026-11-20T03:00:23Z', 'PartiallyFailed', { errors: 2, warnings: 1 }),
    backup('velero-daily-agentic-os-20261121030000', '2026-11-21T03:00:00Z', 'InProgress'),
  ] };
  const v = await readVelero('velero', 'velero-daily-agentic-os', k8sAnswer(body, 200, seen));
  assert.deepEqual(seen, ['/apis/velero.io/v1/namespaces/velero/backups?labelSelector=velero.io%2Fschedule-name%3Dvelero-daily-agentic-os']);
  const a = backupFailureAlerts({ cronJobs: [], velero: v, snapshotRepos: [] });
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'critical');
  assert.match(a[0].title, /Velero backup PartiallyFailed/);
  assert.match(a[0].detail, /2 error\(s\)/);
  const failed = parseVeleroBackups({ items: [backup('b1', '2026-11-20T03:00:00Z', 'Failed', { failureReason: 'backup storage location unavailable' })] });
  assert.match(backupFailureAlerts({ cronJobs: [], velero: { namespace: 'velero', schedule: 's', backups: failed }, snapshotRepos: [] })[0].detail, /storage location unavailable/);
  // Twin: the live shape of 2026-11-20 (Completed with 1 warning) raises nothing.
  assert.deepEqual(backupFailureAlerts({ cronJobs: [], velero: { namespace: 'velero', schedule: 's', backups: parseVeleroBackups({ items: [body.items[0]] }) }, snapshotRepos: [] }), []);
});

test('OpenSearch: the repository\'s newest finished snapshot decides; PARTIAL / FAILED are critical', async () => {
  const cat = [
    { id: 'auto-2026-11-19', status: 'SUCCESS', start_epoch: '1763521200', end_epoch: '1763521260' },
    { id: 'auto-2026-11-20', status: 'PARTIAL', start_epoch: '1763607600', end_epoch: '1763607660' },
    { id: 'auto-2026-11-21', status: 'IN_PROGRESS', start_epoch: '1763694000', end_epoch: '0' },
  ];
  const seen: string[] = [];
  const s = await readSnapshots(['sovereign-fs'], async (p) => { seen.push(p); return { status: 200, body: cat }; });
  assert.deepEqual(seen, ['/_cat/snapshots/sovereign-fs?format=json']);
  const a = backupFailureAlerts({ cronJobs: [], velero: null, snapshotRepos: s });
  assert.equal(a.length, 1);
  assert.match(a[0].title, /OpenSearch snapshot PARTIAL: sovereign-fs/);
  assert.equal(parseSnapshots('not json'), null);
  assert.deepEqual(backupFailureAlerts({ cronJobs: [], velero: null, snapshotRepos: [{ repository: 'r', snapshots: parseSnapshots(cat.slice(0, 1))! }] }), []);
});

test('NO AGE RULE: a backup that is merely old raises nothing (no alert on an age check)', () => {
  const old = { items: [job('pg-dump-1', 'pg-dump', '2020-01-01T02:30:00Z', 'Complete')] };
  const a = backupFailureAlerts({
    cronJobs: [{ cronJob: 'pg-dump', jobs: parseJobs(old, 'pg-dump') }],
    velero: { namespace: 'velero', schedule: 's', backups: parseVeleroBackups({ items: [backup('b', '2020-01-01T03:00:00Z', 'Completed')] }) },
    snapshotRepos: [{ repository: 'r', snapshots: [{ id: 'x', status: 'SUCCESS', endEpoch: 1577840400 }] }],
  });
  assert.deepEqual(a, []);
});
