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

export function accessDriftAlerts(drift: { at: number; restored: boolean; reason?: string } | null, nowMs: number): Alert[] {
  if (!drift || nowMs - drift.at > WINDOW_MS) return [];
  const found = new Date(drift.at).toISOString();
  const base = { id: 'al-trino-rules-drift', domain: 'platform', owner: 'platform', cluster: true, source: 'live' as const };
  if (!drift.restored) {
    return [{ ...base, severity: 'critical', disposition: 'notified', title: 'Trino access rules differ from the OS and could not be restored',
      detail: `The Trino access rules were changed outside the OS, and the OS could not put them back (restore failed: ${drift.reason ?? 'unknown reason'}). The cluster still holds the foreign rules. Found ${found}.`,
      i18n: {
        title: { code: 'monitoring.alert.rulesNotRestored' },
        detail: { code: 'monitoring.alert.rulesNotRestoredDetail', params: { reason: drift.reason ?? 'unknown reason', found } },
      } }];
  }
  return [{ ...base, severity: 'warning', disposition: 'self-healed', title: 'Trino access rules were changed outside the OS',
    detail: `The Trino access rules were changed outside the OS (their hash no longer matched what the OS wrote). The OS restored them from domain membership. Access rights are set through the OS and OPA, not in Trino's rules file. Found ${found}.`,
    i18n: { title: { code: 'monitoring.alert.rulesRestored' }, detail: { code: 'monitoring.alert.rulesRestoredDetail', params: { found } } } }];
}
