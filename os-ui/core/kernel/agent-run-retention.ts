/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    The agent-run RETENTION window — how long a settled run's state is kept
 * USER STORY: As a platform operator I want one env var to decide how long finished agent runs
 *             keep their checkpoint and their event log, with a sane default, an explicit way to
 *             turn retention off, and no chance that a typo silently deletes today's runs.
 * ARCHITECTURE:
 *   - Pure, and in the kernel for the same reason `agents-worker.ts` is: `core/kernel/config.ts`
 *     reads the env var and must not import a tab. The SWEEP that uses this window lives in
 *     `tabs/agents/lib/engine/retention.ts`, which imports these two functions from here.
 *   - `0` is the documented "keep forever"; anything unparseable falls back to the default rather
 *     than to 0, because a typo must not turn retention OFF silently either.
 */

/** Default window: a month of run history is enough to debug a regression, and bounded. */
export const DEFAULT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse `AGENT_RUNS_RETENTION_DAYS`. Unset/garbage → {@link DEFAULT_RETENTION_DAYS}; an explicit
 * `0` (or a negative) → `0`, which DISABLES the sweep. A fractional value is floored to a whole
 * number of days, with a floor of 1, so `0.5` cannot quietly mean "delete everything from today".
 */
export function parseRetentionDays(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  if (t === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(t);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return n <= 0 ? 0 : Math.max(1, Math.floor(n));
}

/** The timestamp before which a SETTLED run is eligible. `0` days ⇒ null (nothing is eligible). */
export function retentionCutoff(now: number, days: number): number | null {
  return days <= 0 ? null : now - days * DAY_MS;
}
