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
 *   - App Builder (C2): when a record of a `templateVersion: 2` app becomes FINISHED here and the switch is on, the
 *     Dev release of that build starts (releases/auto-dev.ts decides; a non-green, unscanned or digest-less record never
 *     deploys). It runs in the background, one at a time per app, so a listing never waits for a rollout. With the
 *     switch off nothing is imported or started.
 *   - Watches are keyed by slug AND sha and resolved to the app whose records hold that sha (slugs repeat across
 *     domains; a sha does not).
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { scheduleEvery } from '@core/reconcile/runtime';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { listAllAppsInternal, persistApp, type App } from '@tabs/software/lib/apps';
import { upsertRecord, type CheckRecord } from '@tabs/software/lib/check-record';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import { readChecksRecord, type ChecksDeps } from '@tabs/software/lib/tekton-checks';

const WATCH_EVERY_MS = 10_000;
const WATCH_FOR_MS = 40 * 60_000;

/** Re-read the running tekton records of `app`; returns true when one changed (and the app was persisted). */
export async function syncAppChecks(app: App, deps: ChecksDeps = {}): Promise<boolean> {
  let changed = false;
  const finished: CheckRecord[] = [];
  for (const rec of [...(app.checks ?? [])]) {
    if (rec.status !== 'running' || rec.engine !== 'tekton') continue;
    const got = await readChecksRecord(app.slug, rec.sha, deps);
    if (got.kind !== 'record' || got.record.status === 'running') continue;
    const done = { ...got.record, trigger: rec.trigger };
    app.checks = upsertRecord(app.checks, done);
    if (done.status === 'finished') finished.push(done);
    changed = true;
  }
  if (changed) await persistApp(app);
  // App Builder: the story lights follow the new criteria evidence (workstream B), then the Dev release (C2).
  if (finished.length && appBuilderEnabled() && templateVersionOf(app) === 2) {
    try {
      await (await import('@tabs/software/lib/stories/lights')).refreshStoryLights(app.id);
    } catch (e) {
      console.error(`[os-ui] checks-sync: story lights of ${app.domain}/${app.slug} not refreshed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const rec of finished) startAutoDev(app, rec);
  return changed;
}

const inFlight = new Map<string, Promise<unknown>>();

/** App Builder (C2): start the Dev release of a finished build in the background (one per app at a time). */
export function startAutoDev(app: App, rec: CheckRecord): void {
  if (!appBuilderEnabled() || templateVersionOf(app) !== 2 || rec.status !== 'finished') return;
  const prev = inFlight.get(app.id) ?? Promise.resolve();
  const run = prev
    .then(async () => (await import('@tabs/software/lib/releases/auto-dev')).autoDeployDev(app, rec))
    .catch((e) => console.error(`[os-ui] auto-dev: ${app.domain}/${app.slug}@${rec.sha.slice(0, 12)} — ${e instanceof Error ? e.message : String(e)}`));
  inFlight.set(app.id, run);
  void run.finally(() => {
    if (inFlight.get(app.id) === run) inFlight.delete(app.id);
  });
}

/** The app whose records hold `sha` for this slug (slugs repeat across domains; a sha identifies the run). */
async function appOfRun(slug: string, sha: string): Promise<App | null> {
  const all = await listAllAppsInternal();
  return all.find((a) => a.slug === slug && a.checks?.some((r) => r.sha === sha)) ?? null;
}

type Watch = { slug: string; sha: string; until: number; deps: ChecksDeps };
const watching = new Map<string, Watch>();
let stopTimer: (() => void) | null = null;

/** One pass over everything being watched; ends the schedule when nothing is left. */
async function tickAll(): Promise<void> {
  for (const [key, w] of [...watching]) {
    try {
      const app = await appOfRun(w.slug, w.sha);
      if (app?.checks?.some((r) => r.sha === w.sha && r.status === 'running')) await syncAppChecks(app, w.deps);
      const after = await appOfRun(w.slug, w.sha);
      const open = after?.checks?.some((r) => r.sha === w.sha && r.status === 'running');
      // A run that had already finished when it was stored (the start waited for it) still gets its Dev release
      // (auto-dev is idempotent per sha and digest).
      const done = after?.checks?.find((r) => r.sha === w.sha && r.status === 'finished');
      if (after && done && !open) startAutoDev(after, done);
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
