/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Live readers for the backup failure alerts (WP-05; backup-failure-alerts-core.ts).
 * USER STORY: As a platform admin I want Monitoring to ask Kubernetes, Velero and OpenSearch
 *             themselves whether last night's backups failed.
 * ARCHITECTURE:
 *   - Kubernetes: GET batch/v1 Jobs in the release namespace, kept when an ownerReference is the
 *     CronJob (Role os-ui-backup-jobs: get,list). Velero: GET velero.io/v1 Backups with the
 *     Schedule's own label `velero.io/schedule-name` (Role os-ui-velero-backups: get,list).
 *   - OpenSearch: `_cat/snapshots/<repository>?format=json` (the upstream cat API).
 *   - Every reader returns `readError` instead of an empty list when the source cannot be read.
 *   - Readers are injectable so the unit test drives them with each tool's real payload shape.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s } from '@core/infra/k8s';
import { opensearchTry } from '@core/adapters/opensearch/client';
import type { Alert } from '@tabs/monitoring/lib/types';
import { backupFailureAlerts, type CronJobInput, type SnapshotRepoInput, type VeleroInput } from '@tabs/monitoring/lib/backup-failure-alerts-core';
import { parseJobs, parseSnapshots, parseVeleroBackups } from '@tabs/monitoring/lib/backup-failure-parse';

type K8s = typeof k8s;
type OsGet = (path: string) => Promise<{ status: number; body: unknown } | null>;

const osGet: OsGet = async (path) => {
  const r = await opensearchTry(path);
  if (!r) return null;
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
};

export async function readCronJobs(names: string[], ns: string, get: K8s = k8s): Promise<CronJobInput[]> {
  if (!names.length) return [];
  const r = await get('GET', `/apis/batch/v1/namespaces/${ns}/jobs`);
  if (r.status !== 200) return names.map((cronJob) => ({ cronJob, readError: `Kubernetes answered HTTP ${r.status}`, jobs: [] }));
  return names.map((cronJob) => ({ cronJob, jobs: parseJobs(r.body, cronJob) }));
}

export async function readVelero(ns: string, schedule: string, get: K8s = k8s): Promise<VeleroInput | null> {
  if (!ns) return null;
  const r = await get('GET', `/apis/velero.io/v1/namespaces/${ns}/backups?labelSelector=${encodeURIComponent(`velero.io/schedule-name=${schedule}`)}`);
  if (r.status !== 200) return { namespace: ns, schedule, readError: `Kubernetes answered HTTP ${r.status}`, backups: [] };
  return { namespace: ns, schedule, backups: parseVeleroBackups(r.body) };
}

export async function readSnapshots(repos: string[], get: OsGet = osGet): Promise<SnapshotRepoInput[]> {
  return Promise.all(repos.map(async (repository) => {
    const r = await get(`/_cat/snapshots/${encodeURIComponent(repository)}?format=json`);
    if (!r) return { repository, readError: 'OpenSearch unreachable', snapshots: [] };
    if (r.status !== 200) return { repository, readError: `OpenSearch answered HTTP ${r.status}`, snapshots: [] };
    const snapshots = parseSnapshots(r.body);
    return snapshots ? { repository, snapshots } : { repository, readError: 'unexpected _cat/snapshots payload', snapshots: [] };
  }));
}

/** The live backup failure alerts of this release (empty when it runs no backup). */
export async function collectBackupFailureAlerts(): Promise<Alert[]> {
  const b = config.backupAlerts;
  const [cronJobs, velero, snapshotRepos] = await Promise.all([
    readCronJobs(b.cronJobs, config.platformNamespace),
    readVelero(b.veleroNamespace, b.veleroSchedule),
    readSnapshots(b.snapshotRepos),
  ]);
  return backupFailureAlerts({ cronJobs, velero, snapshotRepos });
}
