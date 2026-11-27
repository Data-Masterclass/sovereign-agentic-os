/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - a `git push` of story files: refused when malformed, re-indexed when accepted
 * USER STORY: As a developer who edits a story in VS Code and pushes, I want a malformed story or a duplicate id to be
 *             refused with the file, the line and the fix, and an accepted push to show up in the Stories view exactly
 *             like an edit made in the OS.
 * ARCHITECTURE:
 *   - Two registrations, made when this module is imported (git-commit.ts imports it; app-receive.ts imports
 *     git-commit.ts at boot), so no file another workstream owns changes:
 *       1. the repo kind `stories` (core/infra/git-receive `registerRepoKind`): its validator is THE parser the UI and
 *          the store use (files.ts). It matches `apps/<slug>/stories/**` only while the App Builder flag is on, and
 *          only judges an app the receive gate treats as template v2 (`receiveTemplateVersion`, fail-closed), so with
 *          the flag off no push anywhere is judged differently and no ingest line is added.
 *       2. the receive hook `stories-index` (receive-hooks.ts, run by app-receive only with the flag on): after the
 *          push is ingested it re-reads the WHOLE stories subtree at the pushed sha and rebuilds `App.stories` (a
 *          cache; git is the source of truth). The history reads the source of that change as `git`.
 *   - DUPLICATE IDS IN ONE PUSH. The gate validates file by file, synchronously, in one uninterrupted loop. The
 *     validator remembers the ids it saw in the current loop (keyed by app slug) and forgets them in a microtask, i.e.
 *     right after the loop; a second file carrying the same id is refused naming both paths. A duplicate against a
 *     file the push did NOT change cannot be seen by a synchronous per-file validator (the old tree needs an async
 *     read, and the gate's order puts a moved file's addition before its removal); such a push is accepted, the index
 *     keeps the first file, and the push output names both paths (parseLivingSpec reports it). Every OS write path
 *     (store.ts) refuses a duplicate outright.
 */
import 'server-only';
import { APPS_DIR } from '@core/infra/repo-layout';
import { registerRepoKind, type ChangedFile, type IngestReport } from '@core/infra/git-receive';
import { appBuilderEnabled } from '@core/kernel/app-builder-flag';
import { STORIES_DIR, templateVersionOf } from '@tabs/software/lib/app-builder-contracts';
// A namespace import (not a named one): the app commit module imports this module, and a test double that stands in
// for apps.ts without this export must not make every importer of that module fail to link.
import * as appsModule from '@tabs/software/lib/apps';
import { registerReceiveHook, type ReceiveHookInput } from '@tabs/software/lib/receive-hooks';
import { classifyStoryPath, issueLine, parseEpicFile, parseLivingSpec, parseStoryFile, SPEC_LIMITS, STORIES_README } from '@tabs/software/lib/stories/files';

export const STORIES_KIND = 'stories';
export const STORIES_HOOK = 'stories-index';

const STORIES_PATH_RE = new RegExp(`^${APPS_DIR}/([a-z0-9][a-z0-9-]{0,62})/(${STORIES_DIR}/.+)$`);

/** `apps/<slug>/stories/...` → `{ slug, inner: 'stories/...' }`, else null. */
export function splitStoriesPath(path: string): { slug: string; inner: string } | null {
  const m = STORIES_PATH_RE.exec(String(path ?? ''));
  return m ? { slug: m[1], inner: m[2] } : null;
}

export function matchesStories(path: string): boolean {
  return appBuilderEnabled() && splitStoriesPath(path) !== null;
}

/** The receive gate's template version for `apps/<slug>/` (apps.ts, fail-closed to 2; 2 when it is unavailable). */
function templateVersionForReceive(slug: string): number {
  const fn = (appsModule as Partial<typeof appsModule>).receiveTemplateVersion;
  return typeof fn === 'function' ? fn(slug) : 2;
}

/** How far above the highest id the OS has indexed a pushed id may jump (ids are assigned by the OS; a push may add a few). */
export const PUSHED_ID_MARGIN = 1000;

/** The highest indexed ids of apps with this slug, or null when the index cache is cold (no cap rather than a guess). */
function highWaterOf(slug: string): { epic: number; story: number } | null {
  const fn = (appsModule as Partial<typeof appsModule>).receiveSpecIdHighWater;
  return typeof fn === 'function' ? fn(slug) : null;
}

/** Pure: the refusal for a pushed id more than PUSHED_ID_MARGIN above the high-water mark, else null. */
export function pushedIdRefusal(inner: string, kind: 'epic' | 'story', id: string, highWater: { epic: number; story: number } | null): string | null {
  if (!highWater) return null;
  if (Number(id.split('-')[1]) <= highWater[kind] + PUSHED_ID_MARGIN) return null;
  return `${inner}: ${id} is more than ${PUSHED_ID_MARGIN} above the highest ${kind} id of this app (ids are assigned by the OS). Create the ${kind} in the OS, which picks the next free id, then edit its file.`;
}

// ---- duplicate ids within one push (see the header) ----
type Batch = Map<string, string>;
let batch: Batch | null = null;
function currentBatch(): Batch {
  if (!batch) {
    batch = new Map();
    queueMicrotask(() => {
      batch = null;
    });
  }
  return batch;
}

/** The receive gate's validator for one pushed file of an app's living spec. Null = accepted. */
export function validateStoriesFile(file: { path: string; content: string }): string | null {
  if (!appBuilderEnabled()) return null;
  const s = splitStoriesPath(file.path);
  if (!s) return null;
  if (templateVersionForReceive(s.slug) !== 2) return null;
  if (s.inner === STORIES_README) {
    return new TextEncoder().encode(file.content ?? '').length > SPEC_LIMITS.fileBytes ? `${STORIES_README} is larger than ${SPEC_LIMITS.fileBytes} bytes. Shorten it.` : null;
  }
  const where = classifyStoryPath(s.inner);
  if (!where) {
    return `${s.inner} is not part of the living spec layout. Keep only ${STORIES_DIR}/EP-<n>-<name>/_epic.md, ${STORIES_DIR}/EP-<n>-<name>/US-<m>-<name>.md and ${STORIES_README} under ${STORIES_DIR}/.`;
  }
  const r = where.kind === 'epic' ? parseEpicFile(s.inner, file.content) : where.kind === 'story' ? parseStoryFile(s.inner, file.content) : null;
  if (r && 'issues' in r) return issueLine(r.issues[0]) + (r.issues.length > 1 ? ` (and ${r.issues.length - 1} more)` : '');
  if (where.kind === 'readme') return null;
  const capped = pushedIdRefusal(s.inner, where.kind, where.kind === 'epic' ? where.epic : where.story, highWaterOf(s.slug));
  if (capped) return capped;
  const key = where.kind === 'epic' ? `${s.slug}|${where.epic}` : `${s.slug}|${where.story}`;
  const b = currentBatch();
  const prior = b.get(key);
  if (prior !== undefined && prior !== s.inner) {
    const id = key.split('|')[1];
    return where.kind === 'epic'
      ? `${id} has two folders in this push: ${prior} and ${s.inner}. Keep one folder per epic.`
      : `the story id ${id} is used twice in this push: ${prior} and ${s.inner}. Give one of them a new id (create it in the OS, which assigns the next free id).`;
  }
  b.set(key, s.inner);
  return null;
}

/** The kind's ingest: the files were validated; the index is rebuilt by the receive hook after the app ingest. */
export async function ingestStories(input: { files: ChangedFile[] }): Promise<IngestReport> {
  const report: IngestReport = { kind: STORIES_KIND, created: 0, updated: 0, skipped: 0, notes: [] };
  for (const f of input.files) {
    if (f.status === 'added') report.created += 1;
    else if (f.status === 'modified') report.updated += 1;
  }
  return report;
}

/** After the push: re-derive `App.stories` from the whole subtree at the pushed sha (template v2 apps only). */
export async function storiesIndexHook(i: ReceiveHookInput): Promise<string[]> {
  if (templateVersionOf(i.app) !== 2) return [];
  const touched = i.changed.some((f) => splitStoriesPath(f.path) !== null);
  if (!touched && i.app.stories) return [];
  const { readSubtree } = await import('@core/infra/git-store');
  const { config } = await import('@core/kernel/config');
  const read = await readSubtree(i.app.domain, `${APPS_DIR}/${i.app.slug}/${STORIES_DIR}`, { reposDir: config.reposDir, ref: i.sha });
  const files = (read?.files ?? []).map((f) => ({ path: `${STORIES_DIR}/${f.path}`, content: f.content }));
  const { spec, issues } = parseLivingSpec(files, i.sha);
  const { writeSpecIndex } = await import('@tabs/software/lib/stories/store');
  await writeSpecIndex(i.app.id, spec);
  const notes = [`${APPS_DIR}/${i.app.slug}/${STORIES_DIR}/: indexed ${spec.epics.length} epic(s) and ${spec.stories.length} story(ies) at ${i.sha.slice(0, 12)}`];
  if (read?.truncated) notes.push(`${APPS_DIR}/${i.app.slug}/${STORIES_DIR}/: the subtree is larger than one read; the index may be incomplete`);
  for (const x of issues.slice(0, 10)) notes.push(`${APPS_DIR}/${i.app.slug}/${issueLine(x)}`);
  if (issues.length > 10) notes.push(`${APPS_DIR}/${i.app.slug}/${STORIES_DIR}/: ${issues.length - 10} more issue(s)`);
  return notes;
}

/** Idempotent (both registries replace by name). Runs once on import; exported for tests that clear the registries. */
export function registerStoriesReceive(): void {
  registerRepoKind({ kind: STORIES_KIND, matches: matchesStories, validate: validateStoriesFile, ingest: ingestStories });
  registerReceiveHook(STORIES_HOOK, storiesIndexHook);
}

registerStoriesReceive();
