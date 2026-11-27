/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - the receive hook registry (what else happens after a push is ingested)
 * USER STORY: As a workstream author I want to react to a `git push` to an app (re-index the stories, open
 *             post-hoc proposals) without editing the receive path, and I want a failing hook to be reported
 *             in the push output, never to lose the push.
 * ARCHITECTURE:
 *   - `app-receive.ts` (W0-owned) calls `runReceiveHooks` once per ingested app, AFTER the registry was
 *     re-derived and ONLY when the App Builder flag is on (config.appBuilderEnabled). Workstream A registers the
 *     stories index, workstream B the post-hoc proposals. A hook decides itself which apps it handles (for
 *     example `templateVersionOf(app) === 2`).
 *   - A hook returns notes for the push output. A hook that throws becomes one note naming it; the others still
 *     run (a push is never rejected after the fact).
 *   - `onlyStoriesChanged(changed)` is the one shared rule for "this push touched only the living spec": every
 *     changed path of the app is under `stories/`. `tekton-checks.ts` passes the pipeline's `storiesOnly` param
 *     (W0 always sends "false"; C2 wires this function in).
 */
import type { ChangedFile, Pusher } from '@core/infra/git-receive';
import type { App } from '@tabs/software/lib/apps';
import { STORIES_DIR } from '@tabs/software/lib/app-builder-contracts';

export type ReceiveHookInput = { app: App; changed: ChangedFile[]; sha: string; pusher: Pusher; messages: string[] };
export type ReceiveHook = (i: ReceiveHookInput) => Promise<string[] /* notes */>;

const KEY = Symbol.for('soa.software.receiveHooks');
type Registry = Map<string, ReceiveHook>;
const registry = (): Registry => {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[KEY] ??= new Map());
};

export function registerReceiveHook(name: string, h: ReceiveHook): void {
  if (!name.trim()) throw new Error('a receive hook needs a name');
  registry().set(name, h);
}

export function receiveHookNames(): string[] {
  return [...registry().keys()];
}

/** Run every hook in registration order; notes are concatenated, a throw becomes a note. */
export async function runReceiveHooks(i: ReceiveHookInput): Promise<string[]> {
  const notes: string[] = [];
  for (const [name, h] of registry()) {
    try {
      notes.push(...(await h(i)));
    } catch (e) {
      notes.push(`receive hook ${name} failed for ${i.app.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return notes;
}

/**
 * True when every changed path is under the app's `stories/` folder. Paths may be app-relative
 * (`stories/EP-1-x/US-3-y.md`) or repo-relative (`apps/<slug>/stories/...`). An empty set is NOT stories-only.
 */
export function onlyStoriesChanged(changed: Pick<ChangedFile, 'path'>[]): boolean {
  if (changed.length === 0) return false;
  const inner = (p: string) => (p.startsWith('apps/') ? p.split('/').slice(2).join('/') : p.replace(/^\.\//, ''));
  return changed.every((f) => inner(f.path).startsWith(`${STORIES_DIR}/`));
}

/** Tests only. */
export function __resetReceiveHooks(): void {
  registry().clear();
}
