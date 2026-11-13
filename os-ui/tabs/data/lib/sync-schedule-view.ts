/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    What the schedule surfaces are allowed to SAY — the pure view logic behind the sync
 *             panels (engine rebuild B4 review H-3 / M-7)
 * USER STORY: As a dataset owner I want the sync panel to tell me the truth about my schedule: who
 *             runs it, that nothing runs it when the opt-out is engaged, and whatever the schedule
 *             reconcile actually reported — not only the subset of outcomes that happen to carry
 *             `ok: false`.
 * ARCHITECTURE:
 *   - PURE and client-safe (no `server-only`, no k8s, no store): the panels are client components,
 *     so the wording they render has to live somewhere a `.ts` test can reach. The panels call
 *     these functions and render the string; they decide nothing.
 *   - `reconcileSyncSchedule` returns `ok: true` in BOTH branches (flag on: Dagster schedules it;
 *     flag off: nothing schedules it) and puts the difference in `detail`. A panel that showed
 *     `detail` only when `!ok` therefore hid the single most important sentence of the opt-out —
 *     "nothing schedules this". `saveScheduleMessage` shows `detail` whenever it is non-empty.
 *   - `schedulingDisabledNote` is the sentence the schedule PICKERS carry while the opt-out is
 *     engaged, derived from the read-back `source` the status endpoint already returns: `ledger`
 *     means `DATA_PROJECT_GIT` is off, which since B4 means no scheduler exists at all (B4-8).
 */

/** The outcome shape both the route and MCP `set_dataset_sync` hand back (`SyncCronOutcome`). */
export type ScheduleOutcomeView = { ok?: boolean; live?: boolean; detail?: string } | null | undefined;

/** Where the sync read-back came from — `ledger` iff `DATA_PROJECT_GIT` is off. */
export type SyncReadSource = 'ledger' | 'dagster' | undefined | null;

/** True when nothing in the OS will ever trigger this schedule (the B4-8 opt-out). */
export function schedulingDisabled(source: SyncReadSource): boolean {
  return source === 'ledger';
}

/**
 * The one sentence a schedule picker must carry while the opt-out is engaged. Plain, not a hint:
 * the control still saves a cadence, and saving one changes nothing until the flag is on.
 */
export const SCHEDULING_OFF_NOTE =
  'Scheduling is off (DATA_PROJECT_GIT disabled): this cadence is saved but nothing runs it — use "Sync now", or ask an operator to enable data products.';

/** `SCHEDULING_OFF_NOTE` when the opt-out is engaged, else null — for a picker's helper line. */
export function schedulingDisabledNote(source: SyncReadSource): string | null {
  return schedulingDisabled(source) ? SCHEDULING_OFF_NOTE : null;
}

/**
 * The message shown after a sync save. `detail` is shown WHENEVER it is non-empty, because
 * `reconcileSyncSchedule` reports success in both worlds and the distinction lives in the text;
 * `ok: false` only changes the leading mark from "✓" to a warning.
 */
export function saveScheduleMessage(outcome: ScheduleOutcomeView, saved = 'Saved'): string {
  const detail = (outcome?.detail ?? '').trim();
  if (outcome && outcome.ok === false) {
    return `Saved — but: ${detail || 'the schedule could not be reconciled.'}`;
  }
  return detail ? `✓ ${saved} — ${detail}` : `✓ ${saved}`;
}
