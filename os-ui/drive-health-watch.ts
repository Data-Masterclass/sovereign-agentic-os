/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The timer that raises the connected-drive owner alerts
 * USER STORY: As a drive owner I want to be told when my drive's sync failed, is behind, or needs
 *             reconnecting — also when Dagster, which runs the schedule, is itself down.
 * ARCHITECTURE: Lives beside `instrumentation.ts` (the one place allowed to know every tab): the Files tab's
 *   `evaluateDriveHealth` with the Connections store's own `health` for each drive's connection, every
 *   `FILES_SYNC_HEALTH_EVERY_SECONDS` (default 300) through `core/reconcile/runtime.ts`.
 */
import 'server-only';
import { scheduleEvery } from '@core/reconcile/runtime';
import { evaluateDriveHealth } from '@tabs/files/lib/drive-health-server';
import { driveConnectionHealth } from './monitoring-sources';

export function startDriveHealthWatch(): () => void {
  const secs = Number(process.env.FILES_SYNC_HEALTH_EVERY_SECONDS);
  const every = (Number.isFinite(secs) && secs >= 10 ? secs : 300) * 1000;
  return scheduleEvery('drive-health', every, () => evaluateDriveHealth({ connectionHealth: driveConnectionHealth }));
}
