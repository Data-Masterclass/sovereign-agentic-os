/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → alerts: a FAILED backup raises a critical alert (WP-05).
 * USER STORY: As a platform admin I want an alert the morning after a nightly backup failed —
 *             the Postgres dump, the Velero backup or the OpenSearch snapshot — not a week later
 *             when a restore drill notices an old dump.
 * ARCHITECTURE:
 *   - Pure over what each tool itself reports (adapters/backup-failures.ts reads them live):
 *       Kubernetes batch/v1 Job conditions of the CronJob's newest FINISHED Job (`Failed`);
 *       Velero `backups.velero.io` status.phase of the Schedule's newest FINISHED Backup;
 *       OpenSearch `_cat/snapshots` status of each repository's newest FINISHED snapshot.
 *   - A failure → critical. A source that cannot be read → warning (never silence, never green).
 *   - No age rule: a backup that is merely old raises nothing here (that is the drills' job).
 */
import type { Alert } from '@tabs/monitoring/lib/types';

export type JobRead = { name: string; created: string; failed: boolean; complete: boolean; reason?: string; message?: string };
export type CronJobInput = { cronJob: string; readError?: string; jobs: JobRead[] };

export type VeleroBackupRead = { name: string; created: string; phase: string; failureReason?: string; errors?: number; warnings?: number };
export type VeleroInput = { namespace: string; schedule: string; readError?: string; backups: VeleroBackupRead[] };

export type SnapshotRead = { id: string; status: string; endEpoch: number };
export type SnapshotRepoInput = { repository: string; readError?: string; snapshots: SnapshotRead[] };

export type BackupFailureInputs = { cronJobs: CronJobInput[]; velero: VeleroInput | null; snapshotRepos: SnapshotRepoInput[] };

/** Velero's terminal failure phases (velero.io/v1 BackupPhase). */
const VELERO_FAILED = new Set(['Failed', 'PartiallyFailed', 'FailedValidation']);
const VELERO_DONE = new Set(['Completed', ...VELERO_FAILED]);
/** OpenSearch snapshot states that are finished (`_cat/snapshots` status). */
const SNAP_FAILED = new Set(['FAILED', 'PARTIAL', 'INCOMPATIBLE']);

const base = { domain: 'platform', owner: 'platform', cluster: true, disposition: 'notified' as const, source: 'live' as const };

function unreadable(id: string, what: string, err: string): Alert {
  return { ...base, id, severity: 'warning', title: `Backup status unreadable: ${what}`, detail: `${what} could not be read (${err.slice(0, 200)}), so a failed backup would not be seen.` };
}

const newest = <T>(xs: T[], key: (x: T) => number): T | undefined => xs.reduce<T | undefined>((a, x) => (a === undefined || key(x) > key(a) ? x : a), undefined);

export function backupFailureAlerts(i: BackupFailureInputs): Alert[] {
  const out: Alert[] = [];
  for (const c of i.cronJobs) {
    if (c.readError) { out.push(unreadable(`al-backup-job-${c.cronJob}-unreadable`, `the Jobs of CronJob ${c.cronJob}`, c.readError)); continue; }
    const last = newest(c.jobs.filter((j) => j.failed || j.complete), (j) => Date.parse(j.created) || 0);
    if (last?.failed) {
      out.push({ ...base, id: `al-backup-job-${c.cronJob}`, severity: 'critical', title: `Backup job failed: ${c.cronJob}`,
        detail: `The newest run of CronJob ${c.cronJob} (Job ${last.name}, ${last.created}) failed${last.reason ? `: ${last.reason}` : ''}${last.message ? ` — ${last.message.slice(0, 300)}` : ''}.` });
    }
  }
  const v = i.velero;
  if (v) {
    if (v.readError) out.push(unreadable('al-backup-velero-unreadable', `the Velero backups of schedule ${v.schedule}`, v.readError));
    else {
      const last = newest(v.backups.filter((b) => VELERO_DONE.has(b.phase)), (b) => Date.parse(b.created) || 0);
      if (last && VELERO_FAILED.has(last.phase)) {
        out.push({ ...base, id: 'al-backup-velero', severity: 'critical', title: `Velero backup ${last.phase}: ${v.schedule}`,
          detail: `The newest backup of Velero schedule ${v.schedule} (${last.name}, ${last.created}) is ${last.phase}${last.failureReason ? `: ${last.failureReason}` : ''}` +
            `${last.errors ? `; ${last.errors} error(s)` : ''}${last.warnings ? `; ${last.warnings} warning(s)` : ''}. Check: velero backup describe ${last.name} --details.` });
      }
    }
  }
  for (const r of i.snapshotRepos) {
    if (r.readError) { out.push(unreadable(`al-backup-snapshot-${r.repository}-unreadable`, `the snapshots of OpenSearch repository ${r.repository}`, r.readError)); continue; }
    const last = newest(r.snapshots.filter((s) => s.status !== 'IN_PROGRESS'), (s) => s.endEpoch);
    if (last && SNAP_FAILED.has(last.status)) {
      out.push({ ...base, id: `al-backup-snapshot-${r.repository}`, severity: 'critical', title: `OpenSearch snapshot ${last.status}: ${r.repository}`,
        detail: `The newest snapshot of repository ${r.repository} (${last.id}, ended ${new Date(last.endEpoch * 1000).toISOString()}) is ${last.status}. Check: GET _snapshot/${r.repository}/${last.id}.` });
    }
  }
  return out;
}
