/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Roadmap / rollup adapter (Opus spine).
 *
 * Turns each component's start + planned-ready date, its dependencies, and its
 * DERIVED status into a Gantt-ready readiness signal and a bet-level rollup:
 *
 *   - per component: on-track / at-risk / blocked / done, with a bar (start →
 *     plannedReady) the UI renders against a shared timeline;
 *   - per bet: % complete, an at-risk count, and whether the go-live date is
 *     realistic (any incomplete bar planned to finish AFTER go-live, or already
 *     at-risk, makes it not realistic).
 *
 * Readiness rules (respecting dependencies):
 *   - `done`     — derived completed.
 *   - `blocked`  — a dependency isn't completed yet (build order unmet).
 *   - `at-risk`  — planned-ready date has passed while still not completed, OR a
 *                  blocking dependency is itself at-risk/late (slippage cascades).
 *   - `on-track` — otherwise.
 */

import { type ComponentRef } from './model.ts';
import { type ComponentStatus } from './status.ts';

export type Readiness = 'on-track' | 'at-risk' | 'blocked' | 'done';

export type ComponentRoadmap = {
  refId: string;
  start: string;
  plannedReady: string;
  readiness: Readiness;
  /** Days late vs planned-ready (positive = overdue), null when done/not-yet-due. */
  daysLate: number | null;
  dependsOn: string[];
};

export type BetRollup = {
  components: ComponentRoadmap[];
  pct: number;
  atRisk: number;
  blocked: number;
  goLive: string;
  /** Is the go-live date realistic given current readiness + planned dates. */
  goLiveRealistic: boolean;
  /** Single headline signal for the bet. */
  signal: Readiness;
};

function dayDiff(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Compute readiness for every component, then the bet rollup. `today` is injected
 * so the logic is deterministic + unit-testable (default = now).
 */
export function rollup(
  components: ComponentRef[],
  statuses: ComponentStatus[],
  goLive: string,
  today: string = new Date().toISOString().slice(0, 10),
): BetRollup {
  const statusByRef = new Map(statuses.map((s) => [s.refId, s]));
  const out = new Map<string, ComponentRoadmap>();

  // Pass 1: own readiness from derived status + planned date.
  for (const c of components) {
    const st = statusByRef.get(c.id);
    const derived = st?.derived ?? 'planned';
    let readiness: Readiness;
    let daysLate: number | null = null;
    if (derived === 'completed') {
      readiness = 'done';
    } else if (st?.blocked) {
      readiness = 'blocked';
    } else {
      const late = dayDiff(c.plannedReady, today); // >0 => planned date passed
      daysLate = late > 0 ? late : null;
      readiness = late > 0 ? 'at-risk' : 'on-track';
    }
    out.set(c.id, { refId: c.id, start: c.start, plannedReady: c.plannedReady, readiness, daysLate, dependsOn: c.dependsOn });
  }

  // Pass 2: slippage cascades — an on-track component waiting on an at-risk/late
  // dependency is itself at-risk (its plan is no longer credible).
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of components) {
      const r = out.get(c.id);
      if (!r || r.readiness === 'done') continue;
      for (const dep of c.dependsOn) {
        const dr = out.get(dep);
        if (dr && dr.readiness === 'at-risk' && r.readiness === 'on-track') {
          r.readiness = 'at-risk';
          changed = true;
        }
      }
    }
  }

  const done = [...out.values()].filter((r) => r.readiness === 'done').length;
  const atRisk = [...out.values()].filter((r) => r.readiness === 'at-risk').length;
  const blocked = [...out.values()].filter((r) => r.readiness === 'blocked').length;
  const total = components.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  // Go-live realism: realistic only if nothing is at-risk and every incomplete
  // bar is planned to finish on/before go-live.
  const incompleteAfterGoLive = [...out.values()].some(
    (r) => r.readiness !== 'done' && dayDiff(goLive, r.plannedReady) > 0,
  );
  const goLiveRealistic = atRisk === 0 && !incompleteAfterGoLive;

  let signal: Readiness;
  if (total > 0 && done === total) signal = 'done';
  else if (blocked > 0 && atRisk === 0) signal = 'blocked';
  else if (atRisk > 0 || !goLiveRealistic) signal = 'at-risk';
  else signal = 'on-track';

  return { components: [...out.values()], pct, atRisk, blocked, goLive, goLiveRealistic, signal };
}
