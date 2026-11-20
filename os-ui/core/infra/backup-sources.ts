/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    One live read of every backup source (WP-05): the Monitoring backup alerts and
 *             Platform → Backups both use it, so there is no second implementation.
 * USER STORY: As a platform admin I want Monitoring and Platform to ask Kubernetes, Velero and
 *             OpenSearch themselves whether the backups ran and succeeded.
 * ARCHITECTURE:
 *   - Kubernetes: GET batch/v1 Jobs in the release namespace, kept when an ownerReference is the
 *     CronJob (Role os-ui-backup-status: get,list); the newest successful pg-dump Job's pod status
 *     for its termination message (the run's s3:// location; pods get/list, already os-ui's).
 *     Velero: GET velero.io/v1 Backups with the Schedule's label `velero.io/schedule-name`
 *     (Role os-ui-velero-backups: get,list). The WP-56 restore-drill ConfigMap (get, by name).
 *   - OpenSearch: `_cat/snapshots/<repository>?format=json` through the one client.
 *   - Every reader returns `readError` instead of an empty list when the source cannot be read.
 *   - Readers take injectable transports so the unit tests drive them with real payload shapes.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s } from '@core/infra/k8s';
import { opensearchTry } from '@core/adapters/opensearch/client';
import { parseDrills, parseJobs, parseReportedLocation, parseSnapshots, parseVeleroBackups, type CronJobInput, type DrillRead, type SnapshotRepoInput, type VeleroInput } from '@core/infra/backup-sources-parse';

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

/** The s3:// location the newest SUCCESSFUL Job of a CronJob reported (Kubernetes termination message). */
export async function readLastLocation(c: CronJobInput, ns: string, get: K8s = k8s): Promise<string | undefined> {
  const ok = c.jobs.filter((j) => j.complete && !j.failed).sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0))[0];
  if (!ok) return undefined;
  const r = await get('GET', `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${ok.name}`)}`);
  return r.status === 200 ? parseReportedLocation(r.body) : undefined;
}

export type DrillsInput = { readError?: string; drills: DrillRead[] };

/** The WP-56 restore-drill results (ConfigMap written by the drill Jobs). 404 = no drill has run here. */
export async function readDrills(ns: string, name: string, get: K8s = k8s): Promise<DrillsInput> {
  const r = await get('GET', `/api/v1/namespaces/${ns}/configmaps/${name}`);
  if (r.status === 404) return { drills: [] };
  if (r.status !== 200) return { readError: `Kubernetes answered HTTP ${r.status}`, drills: [] };
  const d = parseDrills(r.body);
  return d ? { drills: d } : { readError: 'unexpected ConfigMap payload', drills: [] };
}

export type BackupSources = { cronJobs: CronJobInput[]; velero: VeleroInput | null; snapshotRepos: SnapshotRepoInput[]; pgDumpLocation?: string; drills: DrillsInput };

/** ONE read of every backup source: the alerts and the Platform → Backups panel both use it. */
export async function readBackupSources(): Promise<BackupSources> {
  const b = config.backupAlerts;
  const ns = config.platformNamespace;
  const [cronJobs, velero, snapshotRepos, drills] = await Promise.all([
    readCronJobs(b.cronJobs, ns),
    readVelero(b.veleroNamespace, b.veleroSchedule),
    readSnapshots(b.snapshotRepos),
    readDrills(ns, b.drillConfigMap),
  ]);
  const pg = cronJobs.find((c) => c.cronJob === 'pg-dump');
  const pgDumpLocation = pg && !pg.readError ? await readLastLocation(pg, ns) : undefined;
  return { cronJobs, velero, snapshotRepos, pgDumpLocation, drills };
}

