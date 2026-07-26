/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE, CLIENT-SAFE next-run estimation for the SyncPanel's schedule presets.
 *
 * Deliberately NOT a full cron engine: it understands exactly the simple shapes the
 * panel's presets emit (step-minute "star/n", "m * * * *", "m h * * *", "m h * * d")
 * plus a bare `*` minute. Anything else (lists, ranges, restricted dom/month) returns null
 * and the UI honestly omits the estimate rather than guessing. The authoritative
 * matcher stays server-side (`sync-cron.ts` — a server module this client bundle
 * must not import); this mirrors only the subset it renders.
 *
 * All arithmetic is UTC — the CronJobs run with `timeZone: UTC` (sync-cron.ts), so
 * the estimate matches the real trigger; the UI formats the Date in local time.
 */

type SimpleCron = {
  minute: { every: number } | { at: number };
  hour: number | '*';
  dow: number | '*';
};

/** Parse the supported subset. Null = not a shape we estimate (honest omission). */
export function parseSimpleCron(cron: string): SimpleCron | null {
  const fields = (cron ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, mon, dow] = fields;
  if (dom !== '*' || mon !== '*') return null;

  let minute: SimpleCron['minute'];
  if (min === '*') minute = { every: 1 };
  else if (/^\*\/\d+$/.test(min)) {
    const n = Number(min.slice(2));
    if (n < 1 || n > 59) return null;
    minute = { every: n };
  } else if (/^\d+$/.test(min) && Number(min) <= 59) minute = { at: Number(min) };
  else return null;

  let h: SimpleCron['hour'];
  if (hour === '*') h = '*';
  else if (/^\d+$/.test(hour) && Number(hour) <= 23) h = Number(hour);
  else return null;
  // `*/n * * *` minutes only make sense hourly; a step-minute with a fixed hour is
  // valid cron but not a preset shape — still supported (fires within that hour).

  let d: SimpleCron['dow'];
  if (dow === '*') d = '*';
  else if (/^\d+$/.test(dow) && Number(dow) <= 7) d = Number(dow) % 7;
  else return null;

  return { minute, hour: h, dow: d };
}

/** Next UTC fire time strictly after `from`, or null when the cron isn't a supported
 *  simple shape. Bounded scan (≤ 8 days of minutes) — cheap and total. */
export function nextCronRun(cron: string, from: Date): Date | null {
  const c = parseSimpleCron(cron);
  if (!c) return null;
  const start = Math.floor(from.getTime() / 60000) + 1;
  for (let m = start; m <= start + 8 * 24 * 60; m++) {
    const at = new Date(m * 60000);
    const minOk = 'every' in c.minute ? at.getUTCMinutes() % c.minute.every === 0 : at.getUTCMinutes() === c.minute.at;
    const hourOk = c.hour === '*' || at.getUTCHours() === c.hour;
    const dowOk = c.dow === '*' || at.getUTCDay() === c.dow;
    if (minOk && hourOk && dowOk) return at;
  }
  return null;
}

/** True when the schedule fires at least every ~30 minutes (the cadence where
 *  merge-on-read delete files start to accumulate faster than compaction absorbs —
 *  the research finding the SyncPanel's merge hint surfaces). */
export function isFrequentCron(cron: string): boolean {
  const c = parseSimpleCron(cron);
  if (!c) return false;
  return c.hour === '*' && 'every' in c.minute && c.minute.every <= 30;
}
