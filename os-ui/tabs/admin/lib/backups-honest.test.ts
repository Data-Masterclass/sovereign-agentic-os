/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    Backups & Restore shows no invented backup and offers no restore that does nothing
 * USER STORY: As a platform admin I want the Backups page to say that backup status is not
 *             connected to it (and where to look instead), and not to offer a Restore that only
 *             writes an audit row, so I never believe a store was backed up last night, or
 *             restored just now, on the strength of a hard-coded table.
 * ARCHITECTURE:
 *   - No reader of the backup CronJob or Velero exists in the code, so the five hard-coded
 *     "success on 30 June 2026" targets are gone: `listTargets()` is empty and the page shows
 *     `BACKUP_STATUS_NOTE`, which points at `docs/backups.md`.
 *   - `restore()` refuses with 501 and writes NO audit row: an audit row for a restore that
 *     restored nothing was the false record.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _reset, listTargets, restore } from '@tabs/admin/lib/backups';
import { listAudit } from '@tabs/admin/lib/audit';

beforeEach(() => _reset());

test('no invented backup targets are listed', () => {
  assert.deepEqual(listTargets(), []);
});

test('restore refuses (501) and writes no audit row', async () => {
  const before = listAudit({ prefix: 'backups.restore' }).length;
  assert.throws(
    () => restore({ targetId: 'postgres', confirm: 'restore postgres', tenant: 't', actor: 'sara', role: 'admin' }),
    (e: Error & { status?: number }) => e.status === 501 && /Restore is not available from the UI yet/.test(e.message),
  );
  assert.equal(listAudit({ prefix: 'backups.restore' }).length, before, 'no audit row for a restore that did not happen');
});

test('the page says status is not connected, points at the runbook, and has no Restore button', async () => {
  const { BACKUP_STATUS_NOTE } = await import('@tabs/admin/lib/backups');
  assert.match(String(BACKUP_STATUS_NOTE), /Backup status is not connected to this page yet/);
  assert.match(String(BACKUP_STATUS_NOTE), /docs\/backups\.md/);
  const ui = readFileSync(join(process.cwd(), 'tabs/admin/ui/BackupsRestore.tsx'), 'utf8');
  assert.doesNotMatch(ui, /Restore…|Restore now/);
  assert.match(ui, /BACKUP_STATUS_NOTE/);
});
