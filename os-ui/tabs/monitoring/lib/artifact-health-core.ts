/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Artifact health rules — pure combine and threshold functions for Monitor tiles
 * USER STORY: As a user watching my datasets and agents I want one health dot per artifact
 *             computed the same way everywhere so that the colours mean the same thing.
 * ARCHITECTURE:
 *   - Pure (no IO, no `server-only`); `artifacts-view.ts` is the server half that feeds it.
 *   - `combine` is worse-of with grey = no signal; pipeline health turns amber after 7 days and
 *     red after 30; `ageInDays` takes `nowMs` from the caller.
 */

export type Health = 'green' | 'amber' | 'red' | 'grey';
const RANK: Record<Health, number> = { grey: 0, green: 1, amber: 2, red: 3 };

/** Worse-of, treating grey as "no signal" so a real green/amber/red always wins. */
export function combine(a: Health, b: Health): Health {
  const real = [a, b].filter((h) => h !== 'grey') as Health[];
  if (real.length === 0) return 'grey';
  return real.reduce((x, y) => (RANK[y] > RANK[x] ? y : x));
}

/** Pipeline (freshness/build) health: never-built → grey, else by staleness. */
export function pipelineHealth(anyBuilt: boolean, ageDays: number | null): Health {
  if (!anyBuilt || ageDays === null) return 'grey';
  if (ageDays > 30) return 'red';
  if (ageDays > 7) return 'amber';
  return 'green';
}

/** Data-quality health from the dataset's DQ badge. */
export function dqHealth(quality: 'unknown' | 'passing' | 'failing'): Health {
  return quality === 'failing' ? 'red' : quality === 'passing' ? 'green' : 'grey';
}

/** Last-run health for an agent system. */
export function agentRunHealth(lastRunOk: boolean | null, held: number): Health {
  if (lastRunOk === null) return 'grey'; // never run
  if (!lastRunOk) return 'red';
  return held > 0 ? 'amber' : 'green';
}

/** Whole-days since an ISO timestamp, or null. `nowMs` injected (no Date.now here). */
export function ageInDays(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}
