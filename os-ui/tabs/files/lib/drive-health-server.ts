/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Owner alerts for a connected drive — sync failed · lag over the threshold · needs reconnect
 * USER STORY: As a drive owner I want an in-app alert, once per incident, when my drive's sync fails, when it
 *             has not synced for too long, or when its connection needs reconnecting.
 * ARCHITECTURE:
 *   - The conditions are `drive-sync-health.ts`; this is the delivery: one in-app notification (the OS's one
 *     alert channel, `addNotification`) to the SOURCE'S OWNER, and the incident remembered on the source so
 *     the next evaluation is silent until it clears.
 *   - Evaluated on a timer by os-ui itself (`drive-health-watch.ts`), NOT by the Dagster job: a lag alert
 *     must still fire when Dagster is the thing that is down.
 *   - The connection's health is injected (the Connections store's own `health`); `unknown` raises nothing.
 */
import 'server-only';
import { addNotification } from '@core/notifications/store';
import { ensureSourcesHydrated, listSources, saveSource, sourcesHydrationState } from '@tabs/files/lib/connectors';
import { activeConditions, diffIncidents, lagThresholdMs, type ConnectionHealth } from '@core/infra/drive-sync-health';

export type DriveHealthDeps = {
  connectionHealth: (connectionId: string) => Promise<ConnectionHealth>;
  nowMs?: number;
};

const TITLES = { failed: 'sync failed', lag: 'sync is behind', reconnect: 'needs reconnecting' } as const;

export async function evaluateDriveHealth(deps: DriveHealthDeps): Promise<{ evaluated: number; fired: number }> {
  await ensureSourcesHydrated();
  // A source list that could not be loaded is not "no drives to check" — say nothing rather than clear incidents.
  if (sourcesHydrationState() !== 'hydrated') return { evaluated: 0, fired: 0 };
  const nowMs = deps.nowMs ?? Date.now();
  const threshold = lagThresholdMs();
  let fired = 0;
  const all = listSources();
  for (const s of all) {
    let health: ConnectionHealth = 'unknown';
    if (s.connectionId) {
      try { health = await deps.connectionHealth(s.connectionId); } catch { health = 'unknown'; }
    }
    const { fire, next } = diffIncidents(s.alerts, activeConditions(s, health, nowMs, threshold));
    for (const c of fire) {
      addNotification({ userId: s.owner, kind: 'alert', title: `Drive ${TITLES[c.kind]}: ${s.label}`, body: `${c.text}\nDrive: ${s.label} (${s.provider === 'onedrive' ? 'OneDrive' : 'Google Drive'}), domain ${s.domain}.` });
      fired += 1;
    }
    if (JSON.stringify(next) !== JSON.stringify(s.alerts ?? {})) { s.alerts = next; saveSource(s); }
  }
  return { evaluated: all.length, fired };
}
