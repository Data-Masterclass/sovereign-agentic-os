/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring alert: the policy data update (os-data bundle) has been refused for too long
 * USER STORY: As a platform admin I want Monitoring to show that OPA is held on an old policy revision,
 *             instead of finding a refused compile in the os-ui log hours later.
 * ARCHITECTURE: pure over `osDataBundleStatus()` through `refusalAlert` (core/policy/bundle-alert.ts), the
 *   same text the admins' bell carries. Raised after `refusalAlertMinutes`; gone as soon as a compile
 *   passes (the status has no refusal any more). Admin-only (`cluster: true`).
 */
import { refusalAlert } from '@core/policy/bundle-alert';
import type { OsDataBundleStatus } from '@core/policy/bundle';
import type { Alert } from '@tabs/monitoring/lib/types';

export function policyBundleAlerts(status: Pick<OsDataBundleStatus, 'refused' | 'revision' | 'refusalAlertMinutes'>, nowMs: number): Alert[] {
  const a = refusalAlert(status, nowMs);
  if (!a) return [];
  return [{ id: 'al-policy-data-refused', severity: 'critical', disposition: 'notified', title: a.title, detail: a.detail, domain: 'platform', owner: 'platform', cluster: true, source: 'live' }];
}
