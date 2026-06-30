/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Backups & Restore adapter (from `backup-strategy.md`).
 *
 * Surfaces each protected store's schedule + last success/failure + retention,
 * and lets an Admin trigger a GUARDED restore. Restore is the canonical
 * destructive action: it requires a typed confirmation phrase (`guard.ts`) and
 * is AUDITED here so the audit write is part of the operation, not an
 * afterthought — exactly what the kind gate checks.
 *
 * Pure store (live status comes from Velero/CNPG/ClickHouse/OpenSearch);
 * unit-testable. Restore here is a governed control-plane action against
 * already-provisioned backups — it never provisions infrastructure.
 */
import { assertGuarded } from './guard.ts';
import { audit, type AuditEntry } from './audit.ts';

export type BackupTarget = {
  id: string;
  name: string;
  method: string;
  frequency: string;
  retention: string;
  lastRun: string;
  lastStatus: 'success' | 'failed';
};

const TARGETS: BackupTarget[] = [
  { id: 'k8s-objects', name: 'K8s objects + PVCs', method: 'Velero + CSI snapshots', frequency: 'Nightly', retention: '14–30 days', lastRun: '2026-06-30T02:00:00.000Z', lastStatus: 'success' },
  { id: 'postgres', name: 'Infra Postgres (CNPG)', method: 'WAL archiving + base (PITR)', frequency: 'Continuous + daily', retention: '7–30 days', lastRun: '2026-06-30T02:10:00.000Z', lastStatus: 'success' },
  { id: 'app-postgres', name: 'App Postgres / Supabase', method: 'CNPG base + WAL', frequency: 'Daily + WAL', retention: '7–30 days', lastRun: '2026-06-30T02:15:00.000Z', lastStatus: 'success' },
  { id: 'clickhouse', name: 'ClickHouse (Langfuse)', method: 'BACKUP … TO S3', frequency: 'Daily', retention: '7–14 days', lastRun: '2026-06-30T02:20:00.000Z', lastStatus: 'success' },
  { id: 'opensearch', name: 'OpenSearch indices', method: 'Snapshot repo (S3)', frequency: 'Daily', retention: '7–14 days', lastRun: '2026-06-29T02:25:00.000Z', lastStatus: 'failed' },
  { id: 'forgejo', name: 'Forgejo (git + DB)', method: 'Dump + CNPG', frequency: 'Daily', retention: '14 days', lastRun: '2026-06-30T02:30:00.000Z', lastStatus: 'success' },
];

export type RestoreJob = {
  id: string;
  target: string;
  startedBy: string;
  startedAt: string;
  status: 'running' | 'completed';
  auditId: string;
};

const restores: RestoreJob[] = [];

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

export function listTargets(): BackupTarget[] {
  return TARGETS;
}

export function listRestores(): RestoreJob[] {
  return restores.slice(0, 20);
}

/** The exact phrase the UI must collect to authorize a restore of `targetId`. */
export function restorePhrase(targetId: string): string {
  return `restore ${targetId}`;
}

/**
 * GUARDED restore: throws GuardError(412) unless `confirm` echoes
 * `restore <targetId>`, then records the job and writes an audit entry. Returns
 * the job (with its audit id) so the caller can surface both.
 */
export function restore(input: {
  targetId: string;
  confirm: unknown;
  tenant: string;
  actor: string;
  role: string;
}): { job: RestoreJob; audit: AuditEntry } {
  const t = TARGETS.find((x) => x.id === input.targetId);
  if (!t) throw fail('Unknown backup target', 404);
  assertGuarded('restore', input.targetId, input.confirm); // throws 412 if not confirmed

  const entry = audit({
    tenant: input.tenant,
    actor: input.actor,
    role: input.role,
    action: 'backups.restore',
    target: `backup:${input.targetId}`,
    detail: `Guarded restore of "${t.name}" from last ${t.lastStatus} backup`,
    guarded: true,
  });
  const job: RestoreJob = {
    id: `rst_${Date.now().toString(36)}`,
    target: input.targetId,
    startedBy: input.actor,
    startedAt: new Date().toISOString(),
    status: 'running',
    auditId: entry.id,
  };
  restores.unshift(job);
  return { job, audit: entry };
}

export function _reset(): void {
  restores.length = 0;
}
