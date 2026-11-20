/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The backup failure alerts of Monitoring, over the shared live read (WP-05).
 * USER STORY: As a platform admin I want Monitoring to alert when last night's backups failed.
 * ARCHITECTURE:
 *   - `readBackupSources` (core/infra/backup-sources.ts, shared with Platform → Backups) →
 *     `backupFailureAlerts` (backup-failure-alerts-core.ts). The readers are re-exported for tests.
 */
import 'server-only';
import type { Alert } from '@tabs/monitoring/lib/types';
import { backupFailureAlerts } from '@tabs/monitoring/lib/backup-failure-alerts-core';
import { readBackupSources } from '@core/infra/backup-sources';

export { readBackupSources, readCronJobs, readDrills, readLastLocation, readSnapshots, readVelero, type BackupSources, type DrillsInput } from '@core/infra/backup-sources';

/** The live backup failure alerts of this release (empty when it runs no backup). */
export async function collectBackupFailureAlerts(): Promise<Alert[]> {
  return backupFailureAlerts(await readBackupSources());
}
