/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Backups & Restore adapter.
 *
 * HONEST STATE (2026-11-19). This page used to list five hard-coded backup targets, every one
 * "success" on 30 June 2026, and offered a guarded Restore that wrote an audit row and restored
 * nothing. Nothing in os-ui reads the backup CronJob or Velero yet, so:
 *   • `listTargets()` returns no targets — the page shows `BACKUP_STATUS_NOTE` instead, which
 *     points at the runbook (`docs/backups.md`) where the real state is read with kubectl;
 *   • `restore()` refuses with 501 and writes NO audit row — an audit record of a restore that
 *     did not happen is a false record. Restores are run from the runbook.
 * When a governed reader of the backup jobs exists, it fills `listTargets()` from real status.
 */

export type BackupTarget = {
  id: string;
  name: string;
  method: string;
  frequency: string;
  retention: string;
  lastRun: string;
  lastStatus: 'success' | 'failed';
};

/** What the page says while no backup status is read (and where the real state is). */
export const BACKUP_STATUS_NOTE =
  'Backup status is not connected to this page yet. The nightly backups (the pg-dump CronJob and ' +
  'the Velero schedule) and how to check and restore them are described in the runbook, ' +
  'docs/backups.md in the repository (section "Operations").';

export const RESTORE_UNAVAILABLE = 'Restore is not available from the UI yet. Follow the runbook, docs/backups.md.';

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

/** No reader of real backup status exists yet, so no target is listed (never an invented one). */
export function listTargets(): BackupTarget[] {
  return [];
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
