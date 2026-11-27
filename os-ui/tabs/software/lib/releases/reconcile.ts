/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - the slow reconcile: idle preview slots to zero, legacy image apps marked
 * USER STORY: As the operator I want previews nobody looks at scaled down and legacy apps flagged, without anyone
 *             pressing a button, and nothing of the kind while the App Builder is off.
 * ARCHITECTURE:
 *   - One schedule through `core/reconcile/runtime.ts scheduleEvery` (GLUE-8: overlap-guarded, failures logged), started
 *     at most once per process by `startReleaseReconciler`, which refuses while the switch is off. It is started when the
 *     lifecycle adapter loads consequences.ts at boot (Node runtime only) - so with the switch off nothing is scheduled.
 *   - Each tick: every v2 app's idle preview slots → 0 replicas (previews.ts); `markNeedsRebuild` (writes records only).
 */
import 'server-only';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { scheduleEvery } from '@core/reconcile/runtime';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import { stopIdlePreviews } from '@tabs/software/lib/releases/previews';
import { markNeedsRebuild } from '@tabs/software/lib/releases/needs-rebuild';

export const RECONCILE_EVERY_MS = 10 * 60_000;
const KEY = Symbol.for('soa.software.releaseReconciler');

/** One pass (exported for tests and for an operator-triggered run). */
export async function reconcileReleasesOnce(): Promise<{ stopped: number; marked: number; unmarked: number }> {
  if (!appBuilderEnabled()) return { stopped: 0, marked: 0, unmarked: 0 };
  const { listAllAppsInternal } = await import('@tabs/software/lib/apps');
  let stopped = 0;
  for (const app of await listAllAppsInternal()) {
    if (templateVersionOf(app) !== 2 || !app.domain) continue;
    stopped += (await stopIdlePreviews(app)).length;
  }
  const m = await markNeedsRebuild();
  return { stopped, marked: m.marked.length, unmarked: m.unmarked.length };
}

/** Start the schedule once per process; a no-op (false) while the switch is off or outside the Node server runtime. */
export function startReleaseReconciler(): boolean {
  if (!appBuilderEnabled() || process.env.NEXT_RUNTIME !== 'nodejs') return false;
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[KEY]) return true;
  g[KEY] = true;
  scheduleEvery('app-builder-releases', RECONCILE_EVERY_MS, reconcileReleasesOnce);
  return true;
}
