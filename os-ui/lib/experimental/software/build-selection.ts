/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The Build stage's CAPPED BATCH-SELECT model (pure, unit-tested).
 *
 * The left tree is a hierarchical browser — Epic › Story › (Feature / NFR / Rule). The
 * user ticks a SELECTION checkbox on features (or a story/epic, which cascades to its
 * features) to queue them for the next build; the one Build button builds the selected
 * SET. To keep each result reliable and reviewable we cap a batch at BUILD_BATCH_CAP
 * features: past the cap the extra checkboxes DISABLE with an honest reason — never a
 * silent truncation.
 *
 * This is the SELECTION arithmetic only (which feature-ids are selected, is the cap
 * reached, may a given feature still be ticked). It is deliberately separate from the
 * DONE state (a built ✓ badge derived from real build activity, see story-spec.ts):
 * selection is "queue to build next", done is "already built" — two distinct marks.
 */

/**
 * The batch cap — the max number of FEATURES one Build press may target. Named once so
 * it is trivial to change. Rationale surfaced in the UI: focused batches keep each
 * result reliable and reviewable.
 */
export const BUILD_BATCH_CAP = 8;

/** A stable id for a single selectable feature within a story. */
export function featureId(storyId: string, index: number): string {
  return `${storyId}#f${index}`;
}

/** The minimal story shape the selection model reads. */
export type SelStory = { id: string; spec?: { features?: string[] } };
/** The minimal epic shape the selection model reads. */
export type SelEpic = { id: string; stories: SelStory[] };

/** Every feature-id under a story, in order (empty when the story has no spec features). */
export function storyFeatureIds(story: SelStory): string[] {
  const features = story.spec?.features ?? [];
  return features.map((_, i) => featureId(story.id, i));
}

/** Every feature-id under an epic, across all its stories. */
export function epicFeatureIds(epic: SelEpic): string[] {
  return (epic.stories ?? []).flatMap(storyFeatureIds);
}

/** How many features are currently selected. */
export function selectedCount(selected: ReadonlySet<string>): number {
  return selected.size;
}

/** Is the batch cap reached (or exceeded)? */
export function capReached(selected: ReadonlySet<string>, cap: number = BUILD_BATCH_CAP): boolean {
  return selected.size >= cap;
}

/**
 * May this feature still be TICKED right now? An already-selected feature is always
 * toggle-able (so the user can UN-tick it); an unselected feature is only tickable
 * while the cap has room. This is what disables the extra checkboxes past the cap.
 */
export function canSelectFeature(
  id: string,
  selected: ReadonlySet<string>,
  cap: number = BUILD_BATCH_CAP,
): boolean {
  if (selected.has(id)) return true;
  return selected.size < cap;
}

/** Toggle a single feature — respects the cap on turn-ON (a no-op past the cap). */
export function toggleFeature(
  selected: ReadonlySet<string>,
  id: string,
  cap: number = BUILD_BATCH_CAP,
): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
    return next;
  }
  if (next.size >= cap) return next; // cap reached — turn-ON is refused, never truncates others.
  next.add(id);
  return next;
}

/** A tri-state for a group (story/epic) checkbox derived from its features' selection. */
export type GroupSelectState = 'none' | 'some' | 'all';

/** The group's selection state over its feature-ids (empty group → 'none'). */
export function groupSelectState(ids: string[], selected: ReadonlySet<string>): GroupSelectState {
  if (ids.length === 0) return 'none';
  const on = ids.filter((id) => selected.has(id)).length;
  if (on === 0) return 'none';
  if (on === ids.length) return 'all';
  return 'some';
}

/**
 * Cascade-toggle a GROUP (story/epic): if every feature is already selected, DESELECT
 * them all; otherwise SELECT as many as the cap allows (in order), leaving the rest
 * unselected. Deselect always fully succeeds (it frees room); select respects the cap
 * and never evicts an already-selected feature from another group.
 */
export function toggleGroup(
  selected: ReadonlySet<string>,
  ids: string[],
  cap: number = BUILD_BATCH_CAP,
): Set<string> {
  const next = new Set(selected);
  const allOn = ids.length > 0 && ids.every((id) => next.has(id));
  if (allOn) {
    for (const id of ids) next.delete(id);
    return next;
  }
  for (const id of ids) {
    if (next.has(id)) continue;
    if (next.size >= cap) break; // stop at the cap — the remainder stays unselected.
    next.add(id);
  }
  return next;
}

/** Drop any selected ids that no longer exist in the current tree (spec was edited). */
export function pruneSelection(selected: ReadonlySet<string>, epics: SelEpic[]): Set<string> {
  const live = new Set(epics.flatMap(epicFeatureIds));
  const next = new Set<string>();
  for (const id of selected) if (live.has(id)) next.add(id);
  return next;
}
