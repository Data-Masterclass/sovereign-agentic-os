/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Pure status/progress derivation for the Build stage's EPIC & STORY TREE
 * (Simple view). The tree shows the app's structure as designed — epics →
 * stories — each with an honest status chip:
 *
 *   • building — the story is the CURRENT build target of a run in flight.
 *   • done     — a Build run committed changes for it (the persisted per-story
 *                status the route/stage already writes — reused, not reinvented).
 *   • blocked  — the LAST Build run targeting it failed (session-scoped signal
 *                from the build chat; a later successful run clears it).
 *   • todo     — none of the above.
 *
 * Kept framework-free so precedence is unit-testable: building > blocked > done.
 * (A failed re-run of a done story shows blocked — the fresher signal wins.)
 */

/** The persisted per-story build status (lib/software/apps.ts AppStory.status). */
export type PersistedStoryStatus = 'todo' | 'building' | 'done';

/** The derived status the tree displays. */
export type TreeStoryStatus = 'todo' | 'building' | 'done' | 'blocked';

/** The minimal story/epic shapes the tree logic needs. */
export type TreeStory = { id: string; status?: PersistedStoryStatus };
export type TreeEpic = { id: string; stories: TreeStory[] };

/** Live run signals from the Build chat (session-scoped, never persisted). */
export type BuildRunSignals = {
  /** The story currently targeted by the Build selector, if any. */
  targetedStoryId: string | null;
  /** Is a Build run streaming right now? */
  running: boolean;
  /** Stories whose last Build run failed (cleared by a later success). */
  failedStoryIds: ReadonlySet<string>;
};

/** Derive one story's display status. Precedence: building > blocked > done > todo. */
export function deriveStoryStatus(story: TreeStory, run: BuildRunSignals): TreeStoryStatus {
  if (run.running && run.targetedStoryId === story.id) return 'building';
  if (run.failedStoryIds.has(story.id)) return 'blocked';
  if (story.status === 'done') return 'done';
  // A persisted 'building' with no run in flight is stale — show it honestly as todo.
  return 'todo';
}

/** "3 of 9 stories built" — counts persisted done stories across all epics. */
export function storyProgress(epics: TreeEpic[]): { built: number; total: number } {
  let built = 0;
  let total = 0;
  for (const e of epics) {
    for (const s of e.stories) {
      total += 1;
      if (s.status === 'done') built += 1;
    }
  }
  return { built, total };
}

/** The honest state of a whole epic in the one-at-a-time sequence. */
export type EpicStatus = 'not-started' | 'in-progress' | 'done';

/**
 * Derive an epic's sequence state from its stories' PERSISTED statuses — honest,
 * never guessed:
 *   • done        — the epic has stories AND every one of them is done.
 *   • in-progress — at least one story is done (but not all).
 *   • not-started — no story is done (or the epic has no stories yet).
 */
export function deriveEpicStatus(epic: TreeEpic): EpicStatus {
  const stories = epic.stories ?? [];
  if (stories.length === 0) return 'not-started';
  const doneCount = stories.filter((s) => s.status === 'done').length;
  if (doneCount === stories.length) return 'done';
  if (doneCount > 0) return 'in-progress';
  return 'not-started';
}

/** "2 of 4 stories" for a single epic. */
export function epicProgress(epic: TreeEpic): { built: number; total: number } {
  const stories = epic.stories ?? [];
  return { built: stories.filter((s) => s.status === 'done').length, total: stories.length };
}

/**
 * The CURRENT epic in the one-at-a-time journey — the first epic that isn't done.
 * Returns its index (or -1 when there are no epics, or all are done). This is the
 * epic the Build stage makes visually primary and defaults its scope to.
 */
export function currentEpicIndex(epics: TreeEpic[]): number {
  return epics.findIndex((e) => deriveEpicStatus(e) !== 'done');
}

/**
 * Clamp an epic index into the valid range for one-at-a-time epic navigation
 * (Design detail's prev/next switcher). An empty list yields 0; out-of-range clamps
 * to the nearest end. Pure so the switcher's bounds are unit-testable.
 */
export function clampEpicIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index > count - 1) return count - 1;
  return index;
}
