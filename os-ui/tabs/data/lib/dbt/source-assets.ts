/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The freshness window of a scheduled sync, derived from its own cron
 * USER STORY: As a data engineer I want "the landing has not moved in two schedule intervals" to be
 *             a Dagster freshness check on the ingestion asset, not a guess (checklist D7, D16).
 * ARCHITECTURE:
 *   - Pure. `freshnessMinutesFor` = two schedule intervals: one missed tick is normal jitter, two is
 *     late. The generated `data/dagster/definitions.py` turns it into Dagster's own
 *     `build_last_update_freshness_checks` (WP-49); `os/sources.yml` and its observation probe are gone.
 */

/**
 * The interval between two ticks of a cron the OS writes, in minutes — `null` when the expression
 * is richer than the shapes the OS's own schedule picker produces.
 */
export function cronIntervalMinutes(cron: string): number | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, , dow] = f;
  const step = (field: string): number | null => {
    const m = /^\*\/(\d{1,4})$/.exec(field);
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const fixed = (field: string): boolean => /^\d{1,2}(,\d{1,2})*$/.test(field);
  const minStep = step(min);
  if (minStep && hour === '*') return minStep;
  if (!fixed(min) && min !== '*') return null;
  const hourStep = step(hour);
  if (hourStep) return hourStep * 60;
  if (hour === '*') return 60;
  if (!fixed(hour)) return null;
  if (dom === '*' && dow === '*') return 1440;
  if (dom === '*' && fixed(dow)) return 10080;
  return null;
}

/** Two intervals of tolerance; `null` when the cron shape is unknown (no freshness claim then). */
export function freshnessMinutesFor(cron: string): number | null {
  const i = cronIntervalMinutes(cron);
  return i === null ? null : i * 2;
}
