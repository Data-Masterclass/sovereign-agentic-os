/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Parse each tool's own status payload for the backup failure alerts (WP-05).
 * USER STORY: As a platform admin I want each backup's status read from the tool's own payload,
 *             so that an alert names the real Job, Backup or snapshot that failed.
 * ARCHITECTURE:
 *   - batch/v1 JobList → the Jobs owned by one CronJob (ownerReferences), with their
 *     `Complete` / `Failed` conditions (kubernetes.io/docs/concepts/workloads/controllers/job).
 *   - velero.io/v1 BackupList → name, creation time, status.phase, failureReason, errors.
 *   - OpenSearch `_cat/snapshots?format=json` → id, status, end_epoch. `null` = not that shape.
 */
import type { JobRead, SnapshotRead, VeleroBackupRead } from '@tabs/monitoring/lib/backup-failure-alerts-core';

type Cond = { type?: string; status?: string; reason?: string; message?: string };
type JobJson = { metadata?: { name?: string; creationTimestamp?: string; ownerReferences?: { kind?: string; name?: string }[] }; status?: { conditions?: Cond[] } };

export function parseJobs(body: unknown, cronJob: string): JobRead[] {
  const items = ((body as { items?: JobJson[] })?.items) ?? [];
  return items
    .filter((j) => (j.metadata?.ownerReferences ?? []).some((o) => o.kind === 'CronJob' && o.name === cronJob))
    .map((j) => {
      const conds = j.status?.conditions ?? [];
      const failed = conds.find((c) => c.type === 'Failed' && c.status === 'True');
      const complete = conds.some((c) => c.type === 'Complete' && c.status === 'True');
      return { name: j.metadata?.name ?? '?', created: j.metadata?.creationTimestamp ?? '', failed: !!failed, complete, reason: failed?.reason, message: failed?.message };
    });
}

type BackupJson = { metadata?: { name?: string; creationTimestamp?: string }; status?: { phase?: string; failureReason?: string; errors?: number; warnings?: number } };

export function parseVeleroBackups(body: unknown): VeleroBackupRead[] {
  const items = ((body as { items?: BackupJson[] })?.items) ?? [];
  return items.map((b) => ({ name: b.metadata?.name ?? '?', created: b.metadata?.creationTimestamp ?? '', phase: b.status?.phase ?? '',
    failureReason: b.status?.failureReason, errors: b.status?.errors, warnings: b.status?.warnings }));
}

export function parseSnapshots(body: unknown): SnapshotRead[] | null {
  if (!Array.isArray(body)) return null;
  return body.map((s: { id?: string; status?: string; end_epoch?: string | number }) => ({ id: String(s.id ?? '?'), status: String(s.status ?? ''), endEpoch: Number(s.end_epoch) || 0 }));
}
