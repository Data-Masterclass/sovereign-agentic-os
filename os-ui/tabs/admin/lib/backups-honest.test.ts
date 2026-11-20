/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    Platform → Backups shows the live state of each backup and drill, never "ok" by default
 * USER STORY: As a platform admin I want a failed or missing backup to show red or amber, a good
 *             one green with its age and location, and no Restore that does nothing.
 * ARCHITECTURE:
 *   - `backupRows` over `BackupSources` (the alerts' own read) with each tool's payload shape:
 *     batch/v1 Jobs + the pod termination message, velero.io/v1 Backups, `_cat/snapshots`, and the
 *     WP-56 drill ConfigMap. Negative twins: failed / missing / stale / unreadable never green.
 *   - `restore()` refuses with 501 and writes NO audit row.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _reset, restore } from '@tabs/admin/lib/backups';
import { backupRows } from '@tabs/admin/lib/backup-status-core';
import { parseDrills, parseJobs, parseReportedLocation, parseSnapshots, parseVeleroBackups } from '@core/infra/backup-sources-parse';
import { readDrills, readLastLocation, type BackupSources } from '@core/infra/backup-sources';
import { listAudit } from '@tabs/admin/lib/audit';

beforeEach(() => _reset());

const now = new Date('2026-11-20T12:00:00Z');
const job = (name: string, owner: string, created: string, cond: 'Complete' | 'Failed') => ({
  metadata: { name, creationTimestamp: created, ownerReferences: [{ kind: 'CronJob', name: owner }] },
  status: cond === 'Complete'
    ? { completionTime: created.replace(/:00Z$/, ':40Z'), conditions: [{ type: 'Complete', status: 'True' }] }
    : { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', lastTransitionTime: created }] },
});
const backup = (name: string, created: string, phase: string, extra: Record<string, unknown> = {}) => ({ metadata: { name, creationTimestamp: created }, status: { phase, completionTimestamp: created, progress: { itemsBackedUp: 812, totalItems: 812 }, ...extra } });
const drillCm = (weekly: unknown) => ({ data: { 'weekly.json': JSON.stringify(weekly) } });

function sources(over: Partial<BackupSources> = {}): BackupSources {
  return {
    cronJobs: [
      { cronJob: 'pg-dump', jobs: parseJobs({ items: [job('pg-dump-1', 'pg-dump', '2026-11-20T02:30:00Z', 'Complete')] }, 'pg-dump') },
      { cronJob: 'opensearch-snapshot', jobs: parseJobs({ items: [job('opensearch-snapshot-1', 'opensearch-snapshot', '2026-11-20T03:00:00Z', 'Complete')] }, 'opensearch-snapshot') },
    ],
    velero: { namespace: 'velero', schedule: 'velero-daily-agentic-os', backups: parseVeleroBackups({ items: [backup('velero-daily-agentic-os-20261120030023', '2026-11-20T03:10:00Z', 'Completed', { warnings: 1 })] }) },
    snapshotRepos: [{ repository: 'stackit-s3', snapshots: parseSnapshots([{ id: 'nightly-2026.11.20', status: 'SUCCESS', end_epoch: String(Date.parse('2026-11-20T03:05:00Z') / 1000) }])! }],
    pgDumpLocation: 's3://lakehouse/backups/pg/2026-11-20T02-30-05Z/',
    drills: { drills: parseDrills(drillCm({ kind: 'weekly', at: '2026-11-16T04:30:00Z', status: 'pass', checks: [{ check: 'git', status: 'pass' }, { check: 'postgres', status: 'pass' }] }))! },
    ...over,
  };
}
const byId = (s: BackupSources, veleroConfigured = true) => Object.fromEntries(backupRows(s, now, { veleroConfigured }).map((r) => [r.id, r]));

test('every backup succeeded and is fresh ⇒ green, with its age, location and item count', () => {
  const m = byId(sources());
  for (const id of ['job-pg-dump', 'job-opensearch-snapshot', 'velero', 'snap-stackit-s3', 'drill-weekly']) assert.equal(m[id]?.health, 'green', id);
  assert.match(m['job-pg-dump'].detail, /s3:\/\/lakehouse\/backups\/pg\/2026-11-20T02-30-05Z\//);
  assert.match(m.velero.detail, /812\/812 items/);
  assert.ok(m['job-pg-dump'].ageHours! > 9 && m['job-pg-dump'].ageHours! < 10);
});

test('NEGATIVE TWIN: a failed backup or drill is RED, never green', () => {
  const failedPg = sources({ cronJobs: [{ cronJob: 'pg-dump', jobs: parseJobs({ items: [job('pg-dump-1', 'pg-dump', '2026-11-19T02:30:00Z', 'Complete'), job('pg-dump-2', 'pg-dump', '2026-11-20T02:30:00Z', 'Failed')] }, 'pg-dump') }] });
  assert.equal(byId(failedPg)['job-pg-dump'].health, 'red');
  const failedVelero = sources({ velero: { namespace: 'velero', schedule: 's', backups: parseVeleroBackups({ items: [backup('b1', '2026-11-19T03:00:00Z', 'Completed'), backup('b2', '2026-11-20T03:00:00Z', 'PartiallyFailed', { errors: 3 })] }) } });
  assert.equal(byId(failedVelero).velero.health, 'red');
  const partial = sources({ snapshotRepos: [{ repository: 'stackit-s3', snapshots: parseSnapshots([{ id: 'x', status: 'PARTIAL', end_epoch: String(Date.parse('2026-11-20T03:05:00Z') / 1000) }])! }] });
  assert.equal(byId(partial)['snap-stackit-s3'].health, 'red');
  const drillFail = sources({ drills: { drills: parseDrills(drillCm({ kind: 'weekly', at: '2026-11-19T04:00:00Z', status: 'pass', checks: [{ check: 'postgres', status: 'fail', reason: 'pg_restore failed' }] }))! } });
  assert.equal(byId(drillFail)['drill-weekly'].health, 'red', 'a report claiming pass with a failed check is red');
  const empty = sources({ drills: { drills: parseDrills(drillCm({ kind: 'weekly', at: '2026-11-19T04:00:00Z', status: 'pass', checks: [] }))! } });
  assert.equal(byId(empty)['drill-weekly'].health, 'red', 'a pass with no check proves nothing');
});

test('NEGATIVE TWIN: missing, stale, unreadable or not configured is AMBER, never green', () => {
  const none = byId(sources({ cronJobs: [{ cronJob: 'pg-dump', jobs: [] }], snapshotRepos: [{ repository: 'r', snapshots: [] }], drills: { drills: [] } }));
  assert.equal(none['job-pg-dump'].health, 'amber');
  assert.equal(none['snap-r'].health, 'amber');
  assert.equal(none.drill.health, 'amber');
  const stale = byId(sources({ cronJobs: [{ cronJob: 'pg-dump', jobs: parseJobs({ items: [job('pg-dump-1', 'pg-dump', '2026-11-18T02:30:00Z', 'Complete')] }, 'pg-dump') }] }));
  assert.equal(stale['job-pg-dump'].health, 'amber');
  assert.equal(stale['job-pg-dump'].status, 'stale');
  const future = byId(sources({ snapshotRepos: [{ repository: 'r', snapshots: [{ id: 'x', status: 'SUCCESS', endEpoch: Date.parse('2027-01-01T00:00:00Z') / 1000 }] }] }));
  assert.equal(future['snap-r'].health, 'amber', 'a snapshot dated in the future is not fresh');
  const unread = byId(sources({ cronJobs: [{ cronJob: 'pg-dump', readError: 'Kubernetes answered HTTP 403', jobs: [] }], velero: { namespace: 'velero', schedule: 's', readError: 'Kubernetes answered HTTP 403', backups: [] }, drills: { readError: 'HTTP 403', drills: [] } }));
  assert.equal(unread['job-pg-dump'].health, 'amber');
  assert.equal(unread.velero.health, 'amber');
  assert.equal(unread.drill.health, 'amber');
  assert.equal(byId(sources({ velero: null }), false).velero.health, 'amber', 'Velero not configured says so');
  assert.equal(byId(sources({ velero: null }), false).velero.status, 'not connected');
});

test('the readers: the pg-dump location from the newest successful Job\'s termination message; drills from the ConfigMap (404 = none)', async () => {
  const seen: string[] = [];
  const get = (async (_m: string, path: string) => {
    seen.push(path);
    if (path.includes('/pods?')) return { status: 200, body: { items: [{ status: { containerStatuses: [{ name: 'upload', state: { terminated: { exitCode: 0, message: 's3://lakehouse/backups/pg/2026-11-20T02-30-05Z/' } } }] } }] } };
    return { status: 404, body: {} };
  }) as never;
  const pg = sources().cronJobs[0];
  assert.equal(await readLastLocation(pg, 'agentic-os', get), 's3://lakehouse/backups/pg/2026-11-20T02-30-05Z/');
  assert.equal(seen[0], '/api/v1/namespaces/agentic-os/pods?labelSelector=job-name%3Dpg-dump-1');
  assert.deepEqual(await readDrills('agentic-os', 'restore-drill-status', get), { drills: [] });
  assert.equal(parseReportedLocation({ items: [{ status: { containerStatuses: [{ state: { terminated: { message: 'not a url' } } }] } }] }), undefined);
  const forbidden = (async () => ({ status: 403, body: {} })) as never;
  assert.match((await readDrills('agentic-os', 'restore-drill-status', forbidden)).readError!, /403/);
});

test('restore refuses (501) and writes no audit row; the page has no Restore button and no "not connected" note', () => {
  const before = listAudit({ prefix: 'backups.restore' }).length;
  assert.throws(
    () => restore({ targetId: 'postgres', confirm: 'restore postgres', tenant: 't', actor: 'sara', role: 'admin' }),
    (e: Error & { status?: number }) => e.status === 501 && /Restore is not available from the UI yet/.test(e.message),
  );
  assert.equal(listAudit({ prefix: 'backups.restore' }).length, before);
  const ui = readFileSync(join(process.cwd(), 'tabs/admin/ui/BackupsRestore.tsx'), 'utf8');
  assert.doesNotMatch(ui, /Restore…|Restore now/);
  assert.doesNotMatch(ui, /not connected to this page/);
  assert.match(ui, /\/api\/platform-admin\/backups/);
});
