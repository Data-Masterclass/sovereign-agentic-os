/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The alert text for an os-data bundle refusal that lasts
 * USER STORY: As an admin I want to be told when OPA has been held on an old policy revision for
 *             longer than a few minutes, so a refused compile is never found hours later in a log.
 * ARCHITECTURE:
 *   - Pure over `osDataBundleStatus()`: a refusal whose incident (`refused.since`) is older than
 *     `refusalAlertMinutes` (chart `opa.dataBundle.refusalAlertMinutes`) is an alert; none otherwise,
 *     so it clears by itself when a compile passes. ONE text for both channels: Monitoring's alert
 *     list (tabs/monitoring/lib/policy-bundle-alert-core.ts) and the admins' notification bell
 *     (tabs/admin/lib/opa-bundle-admin.ts `evaluateRefusalBell`). Counts and hashes only.
 */
import type { OsDataBundleStatus } from '@core/policy/bundle';

export type RefusalAlert = { title: string; detail: string; since: string };

export function refusalAlert(status: Pick<OsDataBundleStatus, 'refused' | 'revision' | 'refusalAlertMinutes'>, nowMs: number): RefusalAlert | null {
  const r = status.refused;
  if (!r) return null;
  const sinceMs = Date.parse(r.since);
  if (!Number.isFinite(sinceMs)) return null;
  if (nowMs - sinceMs < status.refusalAlertMinutes * 60_000) return null;
  const minutes = Math.floor((nowMs - sinceMs) / 60_000);
  const removed = r.diff
    ? ` It would remove ${r.diff.grantPrincipals.removedTotal} grant principal(s), ${r.diff.governancePrincipals.removedTotal} governance principal(s) and ${r.diff.tables.removedTotal} table(s).`
    : '';
  return {
    title: 'Policy data update refused',
    detail:
      `OPA has stayed on policy revision ${status.revision ?? '(none)'} for ${minutes} min because a new compile (content ${r.hash}) was refused: ${r.reasons.join('; ')}.` +
      `${removed} No access change since then reaches OPA until an admin reviews and acknowledges it.`,
    since: r.since,
  };
}
