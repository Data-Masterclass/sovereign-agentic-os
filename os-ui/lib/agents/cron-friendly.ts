/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { isValidCron } from './cron-util.ts';

/**
 * Business-friendly recurrence <-> cron. Cron strings are awful for non-coders, so the
 * schedule UI works in terms of a plain {@link Recurrence} (daily / weekly / monthly at
 * a time) and this module translates to/from the raw 5-field cron the CronJob needs.
 *
 * We only model the COMMON patterns a business user picks in a recurrence editor:
 *   • daily   → `M H * * *`
 *   • weekly  → `M H * * d1,d2,…`  (sorted, deduped days-of-week; Sun=0)
 *   • monthly → `M H N * *`        (day-of-month N)
 * Anything richer (ranges, steps, star-slash-n, lists of hours/days-of-month, named days…)
 * is deliberately NOT representable — {@link cronToRecurrence} returns `null` so the UI
 * falls back to the raw "Advanced (cron)" input rather than silently mangling it.
 */

export type Frequency = 'daily' | 'weekly' | 'monthly';

export type Recurrence = {
  frequency: Frequency;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** weekly only: days of week, 0-6, Sun=0 */
  daysOfWeek?: number[];
  /** monthly only: day of month, 1-31 */
  dayOfMonth?: number;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Sort, dedupe and keep only valid 0-6 day indices. */
function normalizeDays(days: number[] | undefined): number[] {
  const clean = Array.from(new Set((days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)));
  clean.sort((a, b) => a - b);
  return clean;
}

/** Zero-pad an hour/minute to two digits for the "HH:MM" summary. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Build the 5-field cron for a recurrence. Weekly with no days defaults to Monday so
 * the result is always a valid, non-empty schedule.
 */
export function recurrenceToCron(r: Recurrence): string {
  const m = r.minute;
  const h = r.hour;
  if (r.frequency === 'daily') return `${m} ${h} * * *`;
  if (r.frequency === 'weekly') {
    const days = normalizeDays(r.daysOfWeek);
    const list = (days.length ? days : [1]).join(',');
    return `${m} ${h} * * ${list}`;
  }
  // monthly
  const dom = r.dayOfMonth && r.dayOfMonth >= 1 && r.dayOfMonth <= 31 ? r.dayOfMonth : 1;
  return `${m} ${h} ${dom} * *`;
}

/** Parse a single numeric field in [min,max]; null if it isn't a plain integer in range. */
function parseNum(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/**
 * Parse the COMMON cron patterns back into a Recurrence, or `null` for anything this
 * friendly model can't represent (ranges, steps, `*`/lists in minute or hour, both
 * day-of-month AND day-of-week constrained, out-of-range values, invalid cron).
 */
export function cronToRecurrence(cron: string): Recurrence | null {
  if (!isValidCron(cron)) return null;
  const [minF, hourF, domF, monF, dowF] = cron.trim().split(/\s+/);

  // Month must be wildcard; minute & hour must be single plain numbers.
  if (monF !== '*') return null;
  const minute = parseNum(minF, 0, 59);
  const hour = parseNum(hourF, 0, 23);
  if (minute === null || hour === null) return null;

  const domWild = domF === '*';
  const dowWild = dowF === '*';

  // Daily: both day fields wildcard.
  if (domWild && dowWild) return { frequency: 'daily', hour, minute };

  // Weekly: day-of-month wildcard, day-of-week is a comma list of plain 0-6 numbers.
  if (domWild && !dowWild) {
    const parts = dowF.split(',');
    const days: number[] = [];
    for (const p of parts) {
      const d = parseNum(p, 0, 6);
      if (d === null) return null;
      days.push(d);
    }
    const daysOfWeek = normalizeDays(days);
    if (!daysOfWeek.length) return null;
    return { frequency: 'weekly', hour, minute, daysOfWeek };
  }

  // Monthly: day-of-week wildcard, day-of-month is a single plain 1-31 number.
  if (!domWild && dowWild) {
    const dayOfMonth = parseNum(domF, 1, 31);
    if (dayOfMonth === null) return null;
    return { frequency: 'monthly', hour, minute, dayOfMonth };
  }

  // Both constrained → not a shape we model.
  return null;
}

/** Human summary, e.g. "Every Monday at 09:00", "Every Mon, Wed, Fri at 14:30". */
export function describeRecurrence(r: Recurrence): string {
  const time = `${pad2(r.hour)}:${pad2(r.minute)}`;
  if (r.frequency === 'daily') return `Daily at ${time}`;
  if (r.frequency === 'monthly') {
    const dom = r.dayOfMonth && r.dayOfMonth >= 1 && r.dayOfMonth <= 31 ? r.dayOfMonth : 1;
    return `Monthly on day ${dom} at ${time}`;
  }
  // weekly
  const days = normalizeDays(r.daysOfWeek);
  const list = days.length ? days : [1];
  if (list.length === 7) return `Every day at ${time}`;
  if (list.length === 1) {
    const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][list[0]];
    return `Every ${full} at ${time}`;
  }
  return `Every ${list.map((d) => DAY_NAMES[d]).join(', ')} at ${time}`;
}
