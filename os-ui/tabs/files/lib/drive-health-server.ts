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
 *   - LANGUAGE (i18n wave 4): written in the OWNER's saved language (`getUserLocale` + `serverTextFor`,
 *     `server.notify.drive.*`); English is byte-identical to before.
 */
import 'server-only';
import { addNotification } from '@core/notifications/store';
import { getUserLocale } from '@core/prefs/locale';
import { serverTextFor } from '@core/i18n/server-text';
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
    // The owner's language is read only when something fires (the evaluation runs on a timer).
    const text = fire.length ? serverTextFor(await getUserLocale(s.owner)) : serverTextFor('en');
    for (const c of fire) {
      const provider = s.provider === 'onedrive' ? 'OneDrive' : 'Google Drive';
      const title = text(`notify.drive.title.${c.kind}`, { label: s.label }, `Drive ${TITLES[c.kind]}: ${s.label}`);
      const what = c.code ? text(c.code, c.params, c.text) : c.text;
      const where = text('notify.drive.where', { label: s.label, provider, domain: s.domain }, `Drive: ${s.label} (${provider}), domain ${s.domain}.`);
      addNotification({ userId: s.owner, kind: 'alert', title, body: `${what}\n${where}` });
      fired += 1;
    }
    if (JSON.stringify(next) !== JSON.stringify(s.alerts ?? {})) { s.alerts = next; saveSource(s); }
  }
  return { evaluated: all.length, fired };
}
