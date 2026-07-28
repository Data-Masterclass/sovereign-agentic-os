/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The TEST → BUILD improvement loop model (pure, unit-tested).
 *
 * The Test stage's "Verify & Improve" runs the reasoning verification of each built
 * story/feature against its Design spec. For every item that FALLS SHORT it drafts a
 * concrete improvement, and free-form feedback (typed into the single stage assistant)
 * becomes one too. Each improvement is an HONEST, reviewable to-do that lands as a
 * pending item in the Build tree — nothing auto-executes.
 *
 * HONEST ROUTING (which home an improvement belongs in):
 *   • 'rebuild' — the built code just MISSED an existing spec item. The fix is to
 *     RE-BUILD that feature/story on the standard model; the spec is unchanged. It shows
 *     as a pending, buildable row in the Build tree.
 *   • 'design'  — the feedback CHANGES what was asked (a new/changed requirement). It
 *     must go to DESIGN first as a spec edit (reasoning), then it becomes buildable. It
 *     shows in the Build tree as a to-do that links back to Design — NOT directly
 *     buildable, because there is no finalized spec for it yet.
 */

export type ImprovementKind = 'rebuild' | 'design';

/** One improvement — tied to a specific story (and optionally a feature within it). */
export type Improvement = {
  id: string;
  kind: ImprovementKind;
  epicId: string;
  storyId: string;
  /** The feature index this improvement targets, when it is feature-specific. */
  featureIndex?: number;
  /** A short human note: what to change ("totals should be bold", "handle empty state"). */
  note: string;
};

/** A raw improvement suggestion from the model / free-text, before id assignment. */
export type RawImprovement = {
  kind?: string;
  epicId?: string;
  storyId?: string;
  featureIndex?: number;
  note?: string;
};

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/**
 * Coerce a model/free-text improvement into a clean Improvement, or null when it can't
 * be tied to a real story. `kind` defaults to 'rebuild' (missed-spec) unless the payload
 * says 'design' — a scope change must be explicit, so we never silently route a fix to
 * Design and strand it. `validStory` checks the story exists (and returns its epicId).
 */
export function normalizeImprovement(
  raw: RawImprovement,
  validStory: (storyId: string) => { epicId: string } | null,
): Improvement | null {
  const storyId = typeof raw.storyId === 'string' ? raw.storyId.trim() : '';
  if (!storyId) return null;
  const found = validStory(storyId);
  if (!found) return null;
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (!note) return null;
  const kind: ImprovementKind = raw.kind === 'design' ? 'design' : 'rebuild';
  const featureIndex = typeof raw.featureIndex === 'number' && raw.featureIndex >= 0 ? raw.featureIndex : undefined;
  return { id: rid('imp'), kind, epicId: found.epicId, storyId, note, featureIndex };
}

/** Is this improvement directly BUILDABLE now? Only a 'rebuild' (spec unchanged) is. */
export function isBuildable(imp: Improvement): boolean {
  return imp.kind === 'rebuild';
}

/** All improvements attached to a given story. */
export function improvementsForStory(improvements: Improvement[], storyId: string): Improvement[] {
  return improvements.filter((i) => i.storyId === storyId);
}

/** Remove an improvement by id (returns a new array). */
export function dropImprovement(improvements: Improvement[], id: string): Improvement[] {
  return improvements.filter((i) => i.id !== id);
}

/** The honest one-word label for an improvement's routing. */
export function kindLabel(kind: ImprovementKind): string {
  return kind === 'rebuild' ? 'rebuild' : 'needs design';
}
