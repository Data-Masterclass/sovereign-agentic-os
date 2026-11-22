/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory CI - keep `App.checks` equal to what Tekton recorded
 * USER STORY: As a builder I want a run that was still going when I looked to show its result when it ends,
 *             without pressing anything, and the same after an os-ui restart.
 * ARCHITECTURE:
 *   - The result of a run lives in Tekton (PipelineRun/TaskRun status and the step logs). This module copies
 *     it into the engine-neutral per-sha record on the app: `syncAppChecks` re-reads every RUNNING tekton
 *     record of an app (called when the app's checks are listed and before a deploy), and `watchChecks`
 *     does the same on a slow timer after a run was started, so a finished result is stored without a viewer.
 *   - Nothing here decides anything: the record is the mapping of Tekton's own status (tekton-record.ts), and the
 *     verdict is recomputed from it by `recordVerdict` wherever it is used. The watcher is a schedule in the
 *     os-ui process, not a queue or an engine; a restart loses nothing, because the listing re-syncs.
 *   - It does nothing at all when no Tekton namespace is configured (no engine, nothing to read).
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { scheduleEvery } from '@core/reconcile/runtime';
import { getAppBySlugInternal, persistApp, type App } from '@tabs/software/lib/apps';
import { upsertRecord } from '@tabs/software/lib/check-record';
import { readChecksRecord, type ChecksDeps } from '@tabs/software/lib/tekton-checks';

const WATCH_EVERY_MS = 10_000;
const WATCH_FOR_MS = 40 * 60_000;

/** Re-read the running tekton records of `app`; returns true when one changed (and the app was persisted). */
export async function syncAppChecks(app: App, deps: ChecksDeps = {}): Promise<boolean> {
  let changed = false;
  for (const rec of [...(app.checks ?? [])]) {
    if (rec.status !== 'running' || rec.engine !== 'tekton') continue;
    const got = await readChecksRecord(app.slug, rec.sha, deps);
    if (got.kind !== 'record' || got.record.status === 'running') continue;
    app.checks = upsertRecord(app.checks, { ...got.record, trigger: rec.trigger });
    changed = true;
  }
  if (changed) await persistApp(app);
  return changed;
}

type Watch = { slug: string; sha: string; until: number; deps: ChecksDeps };
const watching = new Map<string, Watch>();
let stopTimer: (() => void) | null = null;

/** One pass over everything being watched; ends the schedule when nothing is left. */
async function tickAll(): Promise<void> {
  for (const [key, w] of [...watching]) {
    try {
      const app = await getAppBySlugInternal(w.slug);
      if (app?.checks?.some((r) => r.sha === w.sha && r.status === 'running')) await syncAppChecks(app, w.deps);
      const open = (await getAppBySlugInternal(w.slug))?.checks?.some((r) => r.sha === w.sha && r.status === 'running');
      if (!open || Date.now() >= w.until) watching.delete(key);
    } catch (e) {
      // a transient read failure is retried until the deadline (the listing re-syncs anyway); then it is reported, not swallowed
      if (Date.now() >= w.until) {
        console.error(`[os-ui] checks-sync: gave up watching ${key} — ${e instanceof Error ? e.message : String(e)}`);
        watching.delete(key);
      }
    }
  }
  if (watching.size === 0 && stopTimer) {
    stopTimer();
    stopTimer = null;
  }
}

/** After a run was started: copy its result into the app when it ends. At most one watch per app and sha; one shared schedule. */
export function watchChecks(slug: string, sha: string, deps: ChecksDeps = {}): void {
  if (!(deps.namespace ?? config.softwareTektonNamespace)) return;
  const key = `${slug}@${sha}`;
  if (watching.has(key)) return;
  watching.set(key, { slug, sha, until: Date.now() + WATCH_FOR_MS, deps });
  // The one place server code runs a reconcile on a timer (GLUE-8): overlap-guarded, unref'd, failures logged.
  stopTimer ??= scheduleEvery('software-checks-sync', WATCH_EVERY_MS, tickAll);
}
