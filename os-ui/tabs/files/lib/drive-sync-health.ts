/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Drive sync health — the bounded run history kept on a source, lag, and the owner-alert conditions
 * USER STORY: As a drive owner I want every sync run remembered (when, how it was triggered, what it did, why it
 *             failed), and to be told once when a sync fails, when the drive is too far behind, or when its
 *             connection needs reconnecting.
 * ARCHITECTURE:
 *   - Pure (no I/O, no server-only): runs under `node --test`. The history lives ON the `ConnectorSource`
 *     record (mirrored to `os-files-sources`, the existing store) — no new database. Bounded to the last
 *     `MAX_SYNC_RUNS` runs.
 *   - Counts: `added` / `changed` (an update) / `unchanged` are what the sync itself tallies. The sync does not
 *     see or apply removals in the drive and aborts a run at its first failure, so there is no removed count and
 *     no failed-file count to record: a run is `ok` or it is not, with the error text.
 *   - Lag is the time since the last SUCCESSFUL run's end; a source that never synced has NO lag (null), never 0.
 *   - Alerts are incidents with a stable id; `diffIncidents` fires each id once and forgets it when it clears.
 */

export type SyncTrigger = 'manual' | 'schedule';

/** The Dagster job and schedule that run the scheduled pass (`images/extensions/dagster/os_files_sync.py`
 *  defines them under these names; a test in that folder asserts the two files agree). */
export const DRIVE_SYNC_JOB = 'os_files_drive_sync';
export const DRIVE_SYNC_SCHEDULE = 'os_files_drive_sync_schedule';

export type SyncRunRecord = {
  /** ISO start. */
  at: string;
  /** ISO end. */
  endedAt: string;
  durationMs: number;
  trigger: SyncTrigger;
  ok: boolean;
  added: number;
  changed: number;
  unchanged: number;
  /** The error text of a failed run (the provider's or the OS's own message; never a token). */
  error?: string;
};

export const MAX_SYNC_RUNS = 20;

export function appendRun(runs: readonly SyncRunRecord[] | undefined, r: SyncRunRecord): SyncRunRecord[] {
  return [...(runs ?? []), r].slice(-MAX_SYNC_RUNS);
}

export const lastRun = (runs: readonly SyncRunRecord[] | undefined): SyncRunRecord | null => (runs && runs.length ? runs[runs.length - 1] : null);

export function lastOkRun(runs: readonly SyncRunRecord[] | undefined): SyncRunRecord | null {
  for (let i = (runs?.length ?? 0) - 1; i >= 0; i--) if (runs![i].ok) return runs![i];
  return null;
}

/** ms since the last successful run ended; null when no run ever succeeded. */
export function lagMs(runs: readonly SyncRunRecord[] | undefined, _createdAt: string, nowMs: number): number | null {
  const ok = lastOkRun(runs);
  return ok ? Math.max(0, nowMs - Date.parse(ok.endedAt)) : null;
}

const DEFAULT_LAG_MINUTES = 60;

/** `FILES_SYNC_LAG_ALERT_MINUTES` (default 60); anything that is not a positive number is the default. */
export function lagThresholdMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.FILES_SYNC_LAG_ALERT_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_LAG_MINUTES) * 60_000;
}

export type ConnectionHealth = 'healthy' | 'needs-reconnect' | 'unknown';
export type DriveCondition = { kind: 'failed' | 'lag' | 'reconnect'; id: string; text: string };

type HealthSource = { runs?: readonly SyncRunRecord[]; createdAt: string; paused?: { reason: string; at: string } | null };

/** Start of the unbroken streak of failed runs that ends at the latest run, or null when the latest run succeeded. */
export function failingStreakStart(runs: readonly SyncRunRecord[] | undefined): SyncRunRecord | null {
  if (!runs || runs.length === 0 || runs[runs.length - 1].ok) return null;
  let i = runs.length - 1;
  while (i > 0 && !runs[i - 1].ok) i--;
  return runs[i];
}

export function activeConditions(s: HealthSource, connection: ConnectionHealth, nowMs: number, thresholdMs: number): DriveCondition[] {
  const out: DriveCondition[] = [];
  const streak = failingStreakStart(s.runs);
  if (streak) {
    const last = lastRun(s.runs)!;
    out.push({ kind: 'failed', id: `failed:${streak.at}`, text: `The last sync failed: ${last.error ?? 'no error text was recorded'}` });
  }
  if (!s.paused) {
    const ok = lastOkRun(s.runs);
    const since = ok ? Date.parse(ok.endedAt) : Date.parse(s.createdAt);
    const behind = nowMs - since;
    if (behind > thresholdMs) {
      const mins = Math.round(behind / 60_000);
      out.push({ kind: 'lag', id: `lag:${ok ? ok.endedAt : 'never'}`, text: ok ? `The drive has not synced for ${mins} minutes (alert after ${Math.round(thresholdMs / 60_000)}).` : `The drive has never synced successfully since it was connected ${mins} minutes ago.` });
    }
  }
  if (connection === 'needs-reconnect') out.push({ kind: 'reconnect', id: 'reconnect', text: 'The connection needs to be reconnected: its sign-in no longer works, so the drive cannot sync until you reconnect it.' });
  return out;
}

/** Which active conditions are new (fire) and the incident map to store (cleared incidents drop out). */
export function diffIncidents(prev: Record<string, string> | undefined, active: readonly DriveCondition[]): { fire: DriveCondition[]; next: Record<string, string> } {
  const next: Record<string, string> = {};
  const fire: DriveCondition[] = [];
  for (const c of active) {
    next[c.kind] = c.id;
    if ((prev ?? {})[c.kind] !== c.id) fire.push(c);
  }
  return { fire, next };
}
