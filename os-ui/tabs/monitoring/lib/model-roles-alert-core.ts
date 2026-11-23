/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring alert: the model roles are not mapped
 * USER STORY: As a platform admin I am told when the first role mapping keeps failing, so I map the roles by hand
 *             instead of discovering it from "Invalid model name" errors.
 * ARCHITECTURE: pure over the first-mapping retry status (`core/models/role-seed-retry.ts`, `roleSeedAlert`) and
 *   whether a mapping exists now; the same text is the Platform → Models warning. Admin-only (`cluster: true`).
 */
import { roleSeedAlert, type RoleSeedStatus } from '@core/models/role-seed-retry';
import type { Alert } from '@tabs/monitoring/lib/types';

export function modelRolesAlerts(status: RoleSeedStatus | null, mappedNow: boolean): Alert[] {
  const a = roleSeedAlert(status, mappedNow);
  if (!a) return [];
  return [{ id: 'al-model-roles-not-mapped', severity: 'critical', disposition: 'notified', title: a.title, detail: a.detail, domain: 'platform', owner: 'platform', cluster: true, source: 'live' }];
}
