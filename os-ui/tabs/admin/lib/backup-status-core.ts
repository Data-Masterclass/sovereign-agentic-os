/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform → Backups: the live state of every backup and restore drill (WP-05).
 * USER STORY: As a platform admin I want the Backups panel to show what each backup tool itself
 *             reports — last run, result, age, location — and to turn red or amber when a backup
 *             failed, is missing or is stale, never "ok" by default.
 * ARCHITECTURE:
 *   - Pure over `BackupSources`, the SAME read the Monitoring alerts use
 *     (core/infra/backup-sources.ts → readBackupSources): Kubernetes Jobs of the
 *     pg-dump / opensearch-snapshot CronJobs, Velero `backups.velero.io`, OpenSearch
 *     `_cat/snapshots`, and the WP-56 restore-drill ConfigMap. No second reader.
 *   - green: the newest finished run succeeded and is younger than its limit. red: it failed, or
 *     a drill failed. amber: no run yet, stale, a source not configured or unreadable.
 */
import type { BackupSources } from '@core/infra/backup-sources';

export type BackupHealth = 'green' | 'amber' | 'red';
export type BackupRow = {
  id: string;
  name: string;
  source: string;
  health: BackupHealth;
  status: string;
  lastAt: string | null;
  ageHours: number | null;
  detail: string;
};

/** Nightly backups older than this are stale (one missed night plus slack). */
export const NIGHTLY_MAX_AGE_H = 26;
const DRILL_MAX_AGE_D: Record<string, number> = { weekly: 8, velero: 32 };
const CLOCK_SLACK_H = 1;

const ageH = (at: string | undefined | null, now: Date): number | null => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? Math.round(((now.getTime() - t) / 3600e3) * 10) / 10 : null;
};
const fresh = (age: number | null, maxH: number) => age !== null && age <= maxH && age >= -CLOCK_SLACK_H;
const ageText = (age: number | null) => (age === null ? 'unknown age' : age < 0 ? 'dated in the future' : `${age} h ago`);

export function backupRows(src: BackupSources, now: Date, opts: { pgDumpLocation?: string; veleroConfigured: boolean } = { veleroConfigured: !!src.velero }): BackupRow[] {
  const rows: BackupRow[] = [];

  for (const c of src.cronJobs) {
    const id = `job-${c.cronJob}`;
    const name = c.cronJob === 'pg-dump' ? 'Postgres dump (pg-dump)' : c.cronJob === 'opensearch-snapshot' ? 'OpenSearch snapshot job' : c.cronJob;
    const source = `Kubernetes CronJob ${c.cronJob}`;
    if (c.readError) { rows.push({ id, name, source, health: 'amber', status: 'unreadable', lastAt: null, ageHours: null, detail: c.readError }); continue; }
    const finished = c.jobs.filter((j) => j.complete || j.failed).sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
    const last = finished[0];
    const lastOk = finished.find((j) => j.complete && !j.failed);
    const okAt = lastOk ? lastOk.finishedAt ?? lastOk.created : null;
    const age = ageH(okAt, now);
    const where = c.cronJob === 'pg-dump' ? (src.pgDumpLocation ?? (opts.pgDumpLocation ? `${opts.pgDumpLocation} (run folder not reported)` : '')) : '';
    if (!last) { rows.push({ id, name, source, health: 'amber', status: 'no run yet', lastAt: null, ageHours: null, detail: 'No finished Job of this CronJob exists: nothing has been backed up yet.' }); continue; }
    if (last.failed) {
      rows.push({ id, name, source, health: 'red', status: 'failed', lastAt: last.finishedAt ?? last.created, ageHours: ageH(last.finishedAt ?? last.created, now),
        detail: `Newest run ${last.name} failed${last.reason ? ` (${last.reason})` : ''}. Last success: ${okAt ?? 'never'}.` });
      continue;
    }
    rows.push({ id, name, source, health: fresh(age, NIGHTLY_MAX_AGE_H) ? 'green' : 'amber', status: fresh(age, NIGHTLY_MAX_AGE_H) ? 'succeeded' : 'stale',
      lastAt: okAt, ageHours: age, detail: `Last success ${lastOk!.name}, ${ageText(age)}${where ? ` → ${where}` : ''}.` });
  }

  const v = src.velero;
  if (!opts.veleroConfigured || !v) {
    rows.push({ id: 'velero', name: 'Velero cluster backup', source: 'backups.velero.io', health: 'amber', status: 'not connected', lastAt: null, ageHours: null,
      detail: 'Velero is not configured for this release (observability.backupAlerts.velero.namespace), so its backups are not read.' });
  } else if (v.readError) {
    rows.push({ id: 'velero', name: 'Velero cluster backup', source: `backups.velero.io in ${v.namespace}`, health: 'amber', status: 'unreadable', lastAt: null, ageHours: null, detail: v.readError });
  } else {
    const done = v.backups.filter((b) => ['Completed', 'Failed', 'PartiallyFailed', 'FailedValidation'].includes(b.phase)).sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0));
    const last = done[0];
    const lastOk = done.find((b) => b.phase === 'Completed');
    const source = `backups.velero.io, schedule ${v.schedule}`;
    if (!last) rows.push({ id: 'velero', name: 'Velero cluster backup', source, health: 'amber', status: 'no backup yet', lastAt: null, ageHours: null, detail: `No finished Backup of schedule ${v.schedule}.` });
    else {
      const okAt = lastOk ? lastOk.completedAt ?? lastOk.created : null;
      const age = ageH(okAt, now);
      const items = (b: typeof last) => (b.itemsBackedUp !== undefined ? `, ${b.itemsBackedUp}${b.totalItems !== undefined ? `/${b.totalItems}` : ''} items` : '');
      if (last.phase !== 'Completed') {
        rows.push({ id: 'velero', name: 'Velero cluster backup', source, health: 'red', status: last.phase, lastAt: last.completedAt ?? last.created, ageHours: ageH(last.completedAt ?? last.created, now),
          detail: `Newest backup ${last.name} is ${last.phase}${last.failureReason ? `: ${last.failureReason}` : ''}${last.errors ? `, ${last.errors} error(s)` : ''}. Last completed: ${okAt ?? 'never'}.` });
      } else {
        const ok = fresh(age, NIGHTLY_MAX_AGE_H);
        rows.push({ id: 'velero', name: 'Velero cluster backup', source, health: ok ? 'green' : 'amber', status: ok ? 'Completed' : 'stale', lastAt: okAt, ageHours: age,
          detail: `Last completed ${last.name}, ${ageText(age)}${items(last)}${last.warnings ? `, ${last.warnings} warning(s)` : ''}.` });
      }
    }
  }

  for (const r of src.snapshotRepos) {
    const id = `snap-${r.repository}`;
    const name = `OpenSearch snapshots (${r.repository})`;
    const source = `OpenSearch _cat/snapshots/${r.repository}`;
    if (r.readError) { rows.push({ id, name, source, health: 'amber', status: 'unreadable', lastAt: null, ageHours: null, detail: r.readError }); continue; }
    const done = r.snapshots.filter((s) => s.status !== 'IN_PROGRESS').sort((a, b) => b.endEpoch - a.endEpoch);
    const last = done[0];
    if (!last) { rows.push({ id, name, source, health: 'amber', status: 'no snapshot yet', lastAt: null, ageHours: null, detail: 'The repository holds no finished snapshot.' }); continue; }
    const at = new Date(last.endEpoch * 1000).toISOString();
    const age = ageH(at, now);
    if (last.status !== 'SUCCESS') { rows.push({ id, name, source, health: 'red', status: last.status, lastAt: at, ageHours: age, detail: `Newest snapshot ${last.id} is ${last.status}.` }); continue; }
    const ok = fresh(age, NIGHTLY_MAX_AGE_H);
    rows.push({ id, name, source, health: ok ? 'green' : 'amber', status: ok ? 'SUCCESS' : 'stale', lastAt: at, ageHours: age, detail: `Newest snapshot ${last.id}, ${ageText(age)}.` });
  }

  const d = src.drills;
  if (d.readError) rows.push({ id: 'drill', name: 'Restore drills', source: 'restore-drill ConfigMap', health: 'amber', status: 'unreadable', lastAt: null, ageHours: null, detail: d.readError });
  else if (!d.drills.length) rows.push({ id: 'drill', name: 'Restore drills', source: 'restore-drill ConfigMap', health: 'amber', status: 'no drill yet', lastAt: null, ageHours: null, detail: 'No restore drill has reported: no restore is proven.' });
  for (const r of d.drills) {
    const id = `drill-${r.kind}`;
    const name = `Restore drill (${r.kind})`;
    const source = 'restore-drill ConfigMap';
    const age = ageH(r.at, now);
    const checks = Array.isArray(r.checks) ? r.checks : [];
    const failed = checks.filter((c) => c.status !== 'pass');
    if (r.status !== 'pass' || !checks.length || failed.length) {
      rows.push({ id, name, source, health: 'red', status: r.status === 'pass' ? 'fail' : r.status ?? 'fail', lastAt: r.at ?? null, ageHours: age,
        detail: !checks.length ? 'The report holds no check: nothing was proven.' : `Failed: ${failed.map((c) => `${c.check ?? '?'}: ${c.reason ?? c.status ?? 'failed'}`).join('; ').slice(0, 400) || r.status}` });
      continue;
    }
    const ok = fresh(age, (DRILL_MAX_AGE_D[r.kind] ?? 8) * 24);
    rows.push({ id, name, source, health: ok ? 'green' : 'amber', status: ok ? 'pass' : 'stale', lastAt: r.at ?? null, ageHours: age, detail: `Passed: ${checks.map((c) => c.check).join(', ')}; ${ageText(age)}.` });
  }
  return rows;
}
