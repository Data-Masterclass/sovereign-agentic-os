/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring alert: Trino's access rules were changed outside the OS
 * USER STORY: As a platform admin I am told when the access rules were edited by hand and repaired.
 * ARCHITECTURE: pure over `lastDrift()` of the rules reconciler (core/infra/trino-rules-server.ts);
 *   shown for 24 hours after it happened. The OS owns access rights (OPA and the rules it writes).
 */
import type { Alert } from '@tabs/monitoring/lib/types';

const WINDOW_MS = 24 * 3_600_000;

export function accessDriftAlerts(drift: { at: number; detail: string } | null, nowMs: number): Alert[] {
  if (!drift || nowMs - drift.at > WINDOW_MS) return [];
  return [{
    id: 'al-trino-rules-drift', severity: 'warning', domain: 'platform', owner: 'platform', cluster: true, disposition: 'self-healed', source: 'live',
    title: 'Trino access rules were changed outside the OS',
    detail: `${drift.detail} Found ${new Date(drift.at).toISOString()}.`,
  }];
}
