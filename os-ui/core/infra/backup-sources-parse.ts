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
export type JobRead = { name: string; created: string; failed: boolean; complete: boolean; reason?: string; message?: string; finishedAt?: string; reported?: string };
export type CronJobInput = { cronJob: string; readError?: string; jobs: JobRead[] };

export type VeleroBackupRead = { name: string; created: string; phase: string; failureReason?: string; errors?: number; warnings?: number; completedAt?: string; itemsBackedUp?: number; totalItems?: number };
export type VeleroInput = { namespace: string; schedule: string; readError?: string; backups: VeleroBackupRead[] };

export type SnapshotRead = { id: string; status: string; endEpoch: number };
export type SnapshotRepoInput = { repository: string; readError?: string; snapshots: SnapshotRead[] };


type Cond = { type?: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string };
type JobJson = { metadata?: { name?: string; creationTimestamp?: string; ownerReferences?: { kind?: string; name?: string }[] }; status?: { conditions?: Cond[]; completionTime?: string } };

export function parseJobs(body: unknown, cronJob: string): JobRead[] {
  const items = ((body as { items?: JobJson[] })?.items) ?? [];
  return items
    .filter((j) => (j.metadata?.ownerReferences ?? []).some((o) => o.kind === 'CronJob' && o.name === cronJob))
    .map((j) => {
      const conds = j.status?.conditions ?? [];
      const failed = conds.find((c) => c.type === 'Failed' && c.status === 'True');
      const complete = conds.some((c) => c.type === 'Complete' && c.status === 'True');
      const finishedAt = j.status?.completionTime ?? failed?.lastTransitionTime;
      return { name: j.metadata?.name ?? '?', created: j.metadata?.creationTimestamp ?? '', failed: !!failed, complete, reason: failed?.reason, message: failed?.message, finishedAt };
    });
}

type BackupJson = { metadata?: { name?: string; creationTimestamp?: string }; status?: { phase?: string; failureReason?: string; errors?: number; warnings?: number; completionTimestamp?: string; progress?: { itemsBackedUp?: number; totalItems?: number } } };

export function parseVeleroBackups(body: unknown): VeleroBackupRead[] {
  const items = ((body as { items?: BackupJson[] })?.items) ?? [];
  return items.map((b) => ({ name: b.metadata?.name ?? '?', created: b.metadata?.creationTimestamp ?? '', phase: b.status?.phase ?? '',
    failureReason: b.status?.failureReason, errors: b.status?.errors, warnings: b.status?.warnings,
    completedAt: b.status?.completionTimestamp, itemsBackedUp: b.status?.progress?.itemsBackedUp, totalItems: b.status?.progress?.totalItems }));
}

export function parseSnapshots(body: unknown): SnapshotRead[] | null {
  if (!Array.isArray(body)) return null;
  return body.map((s: { id?: string; status?: string; end_epoch?: string | number }) => ({ id: String(s.id ?? '?'), status: String(s.status ?? ''), endEpoch: Number(s.end_epoch) || 0 }));
}

type PodJson = { status?: { containerStatuses?: { state?: { terminated?: { message?: string } } }[] } };

/** The location a Job's container reported in its Kubernetes termination message (an s3:// URL), if any. */
export function parseReportedLocation(body: unknown): string | undefined {
  const items = ((body as { items?: PodJson[] })?.items) ?? [];
  for (const p of items) for (const c of p.status?.containerStatuses ?? []) {
    const m = c.state?.terminated?.message?.trim();
    if (m && /^s3:\/\/[^\s]+$/.test(m)) return m;
  }
  return undefined;
}

export type DrillRead = { kind: string; at?: string; status?: string; checks?: { check?: string; status?: string; reason?: string }[] };

/** The restore-drill status ConfigMap (WP-56 drill-report.sh): one `<kind>.json` per drill. */
export function parseDrills(body: unknown): DrillRead[] | null {
  const data = (body as { data?: Record<string, string> })?.data;
  if (!data || typeof data !== 'object') return null;
  const out: DrillRead[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (!k.endsWith('.json')) continue;
    try {
      const j = JSON.parse(v) as Omit<DrillRead, 'kind'>;
      out.push({ ...j, kind: k.slice(0, -5) });
    } catch {
      out.push({ kind: k.slice(0, -5), status: 'unreadable' });
    }
  }
  return out;
}
