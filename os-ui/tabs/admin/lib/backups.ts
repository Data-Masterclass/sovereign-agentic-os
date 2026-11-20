/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * FEATURE:    Backups & Restore adapter — the live backup state for Platform → Backups (WP-05).
 * USER STORY: As a platform admin I want the Backups panel to show each backup's real last run,
 *             result and age, read from the tool itself, and a restore that is never faked.
 * ARCHITECTURE:
 *   - `listBackups()` = `backupRows(readBackupSources())`: the SAME read the Monitoring backup
 *     alerts use (Kubernetes Jobs, Velero backups, OpenSearch snapshots, the restore-drill
 *     ConfigMap). No status is invented: a missing, stale or unreadable source is amber, a failed
 *     backup or drill is red.
 *   - `restore()` refuses with 501 and writes NO audit row — an audit record of a restore that did
 *     not happen is a false record. Restores are run from the runbook (docs/backups.md).
 */
import { config } from '@core/kernel/config';
import { readBackupSources } from '@core/infra/backup-sources';
import { backupRows, type BackupRow } from '@tabs/admin/lib/backup-status-core';

export type { BackupRow } from '@tabs/admin/lib/backup-status-core';

export const RESTORE_UNAVAILABLE = 'Restore is not available from the UI yet. Follow the runbook, docs/backups.md.';

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

/** Every backup and restore drill of this release, read live. */
export async function listBackups(now = new Date()): Promise<BackupRow[]> {
  const src = await readBackupSources();
  return backupRows(src, now, { pgDumpLocation: config.backupAlerts.pgDumpLocation || undefined, veleroConfigured: !!config.backupAlerts.veleroNamespace });
}

/** Refused: nothing in the OS performs a restore, so nothing is recorded as one. */
export function restore(_input: {
  targetId: string;
  confirm: unknown;
  tenant: string;
  actor: string;
  role: string;
}): never {
  throw fail(RESTORE_UNAVAILABLE, 501);
}

export function _reset(): void {
  /* no state */
}
