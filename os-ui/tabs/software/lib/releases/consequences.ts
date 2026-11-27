/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - what going live in Prod starts, in the release's own words (the confirm dialog)
 * USER STORY: As the person going live I want the confirm dialog to say which release, digest and pending
 *             migrations will run in Prod before I confirm.
 * ARCHITECTURE:
 *   - EXTENSION POINT created by W0, owned by workstream C2. The app lifecycle adapter's `consequences`
 *     (lifecycle-adapter.ts, owner F) calls `releaseConsequences(app)` ONLY while the App Builder flag is on; with it
 *     off the adapter has no consequences, exactly as before.
 *   - For a v2 app: the Dev release that would go live (sha, digest, "nothing is rebuilt"), the migration files at that
 *     sha that Prod has not applied yet (from git, names only - the go-live card shows the SQL), the unreviewed-changes
 *     block for Domain/Company scope, and the Prod database backup state. Every other app: no sentences.
 *   - Loading this module (the lifecycle adapter does, at boot) loads the release store, which reserves `os/releases/`
 *     for the dbt whole-tree generator, and starts the release reconciler - both only with the switch on.
 */
import 'server-only';
import { templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { scopeOfVisibility } from '@core/policy/go-live-rules';
import { currentRelease } from '@tabs/software/lib/releases/store';
import { startReleaseReconciler } from '@tabs/software/lib/releases/reconcile';

startReleaseReconciler();

/** The migration names (node-pg-migrate: file name without `.sql`) a tree carries, sorted. */
export function migrationNames(files: { path: string }[]): string[] {
  return files
    .map((f) => /^db\/migrations\/([^/]+)\.sql$/.exec(f.path)?.[1])
    .filter((n): n is string => !!n)
    .sort();
}

/** Pure: the migrations at the candidate sha that Prod has not applied. */
export function pendingProdMigrations(app: Pick<App, 'database'>, files: { path: string }[]): string[] {
  const applied = new Set(app.database?.prod?.migrations.applied ?? []);
  return migrationNames(files).filter((n) => !applied.has(n));
}

/** Pure: the sentences, given the tree of the candidate release (null when it could not be read). */
export function consequenceSentences(app: Pick<App, 'releases' | 'database' | 'unreviewed' | 'visibility'>, files: { path: string }[] | null): string[] {
  const dev = currentRelease(app, 'dev');
  if (!dev) return ['There is no running Dev release yet, so there is nothing to take live in Prod.'];
  const out = [`Prod will run Dev release ${dev.id}: commit ${dev.sha.slice(0, 12)}, image ${dev.digest.slice(0, 19)}… (the same image, nothing is rebuilt).`];
  if (files === null) out.push('The pending migrations could not be read from git; they run before the rollout and a failure stops it.');
  else {
    const pending = pendingProdMigrations(app, files);
    out.push(pending.length ? `These migrations run in Prod first (forward-only; a failure stops the go-live): ${pending.join(', ')}.` : 'No new database migrations run in Prod.');
  }
  const scope = scopeOfVisibility(app.visibility);
  if (scope !== 'my' && (app.unreviewed?.length ?? 0) > 0) out.push(`Blocked: ${app.unreviewed!.length} change(s) pushed without review must be approved before a ${scope === 'domain' ? 'Domain' : 'Company'} go-live.`);
  if (app.database?.prod || app.database?.dev) out.push('The Prod database has no backup configured.');
  return out;
}

export async function releaseConsequences(app: App): Promise<string[]> {
  if (templateVersionOf(app) !== 2) return [];
  const dev = currentRelease(app, 'dev');
  let files: { path: string }[] | null = null;
  if (dev) {
    try {
      const { readAppTreeState } = await import('@tabs/software/lib/git-commit');
      const s = await readAppTreeState(app, { ref: dev.sha });
      files = s.kind === 'tree' ? s.files : null;
    } catch {
      files = null;
    }
  }
  return consequenceSentences(app, files);
}
