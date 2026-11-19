/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The one sentence a saved cron schedule gets, from the CronJob AND the platform gate
 * USER STORY: As an agent builder I want the saved-schedule message to say whether my system will
 *             really run on schedule on this install, not only whether a CronJob exists.
 * ARCHITECTURE:
 *   - Pure; both builder views (Simple and Developer) call it with the schedule route's answer.
 *   - A CronJob that exists still runs nothing while scheduled runs are switched off: every
 *     firing is refused by `runScheduledSystem` (build/scheduled.ts) until a platform admin
 *     enables autonomous agents.
 */
export type CronResult = { ok: boolean; live: boolean; action: string; detail: string };

export function scheduleSavedNote(cron: CronResult, autonomousEnabled: boolean): string {
  if (!cron.ok || !cron.live) return `⚠ schedule saved but not scheduled — ${cron.detail}`;
  if (!autonomousEnabled) {
    return (
      `Scheduled, but scheduled runs are switched off on this install — each firing is refused until ` +
      `a platform admin enables autonomous agents (Platform → Settings). CronJob ${cron.action}.`
    );
  }
  return `✓ CronJob ${cron.action} — runs on schedule`;
}
