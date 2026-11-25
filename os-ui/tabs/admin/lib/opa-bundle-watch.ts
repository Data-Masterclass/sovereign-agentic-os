/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    The boot wiring of Platform → Policy data: the refusal history and the admins' bell alert
 * USER STORY: As an admin I want every refusal and its end in the audit trail, and an in-app alert
 *             when a refusal lasts, without anyone having to read the os-ui log.
 * ARCHITECTURE:
 *   - Started by `instrumentation.ts` next to `startOsDataBundle()` (web process, bundle mode).
 *   - Subscribes to the bundle's event port (`onOsDataBundleEvent`; the kernel never imports a tab)
 *     and writes each refusal start and end into the one audit store (`recordBundleEvent`).
 *   - Every 60 s through the reconciler runtime (`scheduleEvery`, never a bare timer):
 *     `evaluateRefusalBell` over the existing notification inbox (`addNotification` / `markRead`)
 *     for the active admins of the directory (`listAccess`).
 */
import 'server-only';
import { scheduleEvery } from '@core/reconcile/runtime';
import { onOsDataBundleEvent, osDataBundleStatus } from '@core/policy/bundle';
import { addNotification, ensureHydrated as ensureNotificationsHydrated, markRead } from '@core/notifications/store';
import { audit } from '@tabs/admin/lib/audit';
import { currentTenantId } from '@tabs/admin/lib/tenant';
import { ensureHydrated as ensureTenantUsersHydrated, listAccess } from '@tabs/admin/lib/tenant-users';
import { evaluateRefusalBell, recordBundleEvent, type BellIncident } from '@tabs/admin/lib/opa-bundle-admin';

/** The ids of the admins who may act on it: role admin, not deactivated, not disabled. */
export async function activeAdminIds(): Promise<string[]> {
  await ensureTenantUsersHydrated();
  return (await listAccess()).filter((u) => u.role === 'admin' && u.active && !u.disabled).map((u) => u.id);
}

export function startOpaBundleWatch(opts: { everyMs?: number } = {}): () => void {
  const off = onOsDataBundleEvent((e) => recordBundleEvent(e, currentTenantId(), audit));
  let incident: BellIncident = null;
  const stop = scheduleEvery('opa-bundle.refusal-alert', opts.everyMs ?? 60_000, async () => {
    await ensureNotificationsHydrated();
    incident = await evaluateRefusalBell(incident, {
      status: osDataBundleStatus,
      admins: activeAdminIds,
      notify: addNotification,
      markRead: (userId, ids) => { markRead(userId, ids); },
    });
  });
  return () => {
    off();
    stop();
  };
}
