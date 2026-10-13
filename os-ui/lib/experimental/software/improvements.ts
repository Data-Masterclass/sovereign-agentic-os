/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The TEST → DESIGN → BUILD refinement model (pure, unit-tested).
 *
 * The Test stage's 5-dimension verification runs the reasoning check of each built
 * story/feature against its Design spec across Functionality · User Experience ·
 * Code Structure · Security · Documentation. For every shortfall it drafts a concrete
 * REFINEMENT tagged with the dimension it failed; free-form feedback (typed into the
 * single stage assistant) becomes one too. Each refinement is an HONEST, reviewable
 * to-do with a lifecycle — nothing auto-executes.
 *
 * HONEST ROUTING (which home a refinement belongs in):
 *   • 'rebuild' — the built code just MISSED an existing spec item. The fix is to
 *     RE-BUILD that feature/story on the standard model; the spec is unchanged. It is
 *     directly buildable.
 *   • 'design'  — the feedback CHANGES what was asked (a new/changed requirement). It
 *     must go to DESIGN first as a spec edit (reasoning), then it becomes buildable.
 *     A 'design'-kind refinement is NOT buildable until it has been designed.
 *
 * LIFECYCLE (state, additive, default 'proposed'):
 *   proposed → designed → built
 *   A 'design'-kind item must pass through 'designed' (a drafted spec attached) before
 *   it can build — the design-before-build gate. A 'rebuild'-kind item is buildable
 *   straight from 'proposed' (its spec already exists). Everything stays VISIBLE after
 *   designed/built — done items are retained, never dropped.
 */

export type ImprovementKind = 'rebuild' | 'design';

/** The five Test dimensions a refinement can be tagged with (1:1 with BUILD_PRINCIPLES). */
export type RefinementDimension = 'functionality' | 'ux' | 'code' | 'security' | 'docs';

/** The lifecycle state of a refinement. */
export type RefinementState = 'proposed' | 'designed' | 'built';

/** One refinement — tied to a specific story (and optionally a feature within it). */
export type Improvement = {
  id: string;
  kind: ImprovementKind;
  epicId: string;
  storyId: string;
  /** The feature index this refinement targets, when it is feature-specific. */
  featureIndex?: number;
  /** A short human note: what to change ("totals should be bold", "handle empty state"). */
  note: string;
  /** The Test dimension this refinement addresses (when it came from the 5-dim verify). */
  dimension?: RefinementDimension;
  /** Lifecycle state (additive; absent === 'proposed' for legacy items). */
  state?: RefinementState;
  /** The spec drafted for a 'design'-kind item when it was designed (feeds the build). */
  draftedSpec?: string;
};

/** The refinement lifecycle is an alias of Improvement — the tracked, stateful form. */
export type Refinement = Improvement;

/** A raw refinement suggestion from the model / free-text, before id assignment. */
export type RawImprovement = {
  kind?: string;
  epicId?: string;
  storyId?: string;
  featureIndex?: number;
  note?: string;
  dimension?: string;
};

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

const DIMENSIONS: readonly RefinementDimension[] = ['functionality', 'ux', 'code', 'security', 'docs'];

/** Coerce an arbitrary value into a valid dimension, or undefined. */
function asDimension(v: unknown): RefinementDimension | undefined {
  return typeof v === 'string' && (DIMENSIONS as readonly string[]).includes(v) ? (v as RefinementDimension) : undefined;
}

/** The effective lifecycle state (legacy items with no state read as 'proposed'). */
export function refinementState(imp: Improvement): RefinementState {
  return imp.state ?? 'proposed';
}

/**
 * Coerce a model/free-text refinement into a clean Improvement, or null when it can't
 * be tied to a real story. `kind` defaults to 'rebuild' (missed-spec) unless the payload
 * says 'design' — a scope change must be explicit, so we never silently route a fix to
 * Design and strand it. `validStory` checks the story exists (and returns its epicId).
 * The Test dimension is carried through when present.
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
  const dimension = asDimension(raw.dimension);
  return { id: rid('imp'), kind, epicId: found.epicId, storyId, note, featureIndex, dimension, state: 'proposed' };
}

// ------------------------------------------------------------------ lifecycle gate --

/**
 * Is this refinement directly BUILDABLE now? A 'rebuild' (spec unchanged) always is; a
 * 'designed' item (its spec has been drafted) is too. A 'design'-kind item still in
 * 'proposed' is NOT — it must be designed first (the design-before-build gate). A
 * 'built' item is done, not buildable again.
 */
export function isBuildable(imp: Improvement): boolean {
  if (refinementState(imp) === 'built') return false;
  return imp.kind === 'rebuild' || refinementState(imp) === 'designed';
}

/**
 * Does this refinement still need a DESIGN pass? Only a 'design'-kind item that is still
 * 'proposed' — a 'rebuild' skips design, and an already-'designed'/'built' item is past it.
 */
export function isDesignable(imp: Improvement): boolean {
  return imp.kind === 'design' && refinementState(imp) === 'proposed';
}

/** Attach a drafted spec and advance a refinement to 'designed' (idempotent-safe, pure). */
export function markDesigned(imp: Improvement, draftedSpec: string): Improvement {
  return { ...imp, state: 'designed', draftedSpec };
}

/** Advance a refinement to 'built' (its rebuild/build ran). Pure. */
export function markBuilt(imp: Improvement): Improvement {
  return { ...imp, state: 'built' };
}

// ------------------------------------------------------------------- id transforms --

/** Apply a pure transform to the refinement with the given id (returns a new array). */
function mapById(list: Improvement[], id: string, fn: (imp: Improvement) => Improvement): Improvement[] {
  return list.map((i) => (i.id === id ? fn(i) : i));
}

/** Mark one refinement designed (by id) with a drafted spec. */
export function markDesignedById(list: Improvement[], id: string, draftedSpec: string): Improvement[] {
  return mapById(list, id, (i) => markDesigned(i, draftedSpec));
}

/** Mark one refinement built (by id). */
export function markBuiltById(list: Improvement[], id: string): Improvement[] {
  return mapById(list, id, markBuilt);
}

// -------------------------------------------------------------------- selectors --

/** All refinements attached to a given story. */
export function improvementsForStory(improvements: Improvement[], storyId: string): Improvement[] {
  return improvements.filter((i) => i.storyId === storyId);
}

/** Refinements that still need a Design pass (isDesignable). */
export function refinementsToDesign(list: Improvement[]): Improvement[] {
  return list.filter(isDesignable);
}

/** Refinements ready to build now (isBuildable). */
export function refinementsToBuild(list: Improvement[]): Improvement[] {
  return list.filter(isBuildable);
}

/** ALL refinements, including done ('built') ones — they stay visible, never dropped. */
export function allRefinements(list: Improvement[]): Improvement[] {
  return list.slice();
}

// ---------------------------------------------------------------------- batches --

/**
 * DESIGN-ALL: attach a drafted spec to every designable refinement. `draftFor` yields
 * the spec text for a given refinement (e.g. the reasoning design output). Non-designable
 * items pass through untouched. Pure.
 */
export function designAll(list: Improvement[], draftFor: (imp: Improvement) => string): Improvement[] {
  return list.map((i) => (isDesignable(i) ? markDesigned(i, draftFor(i)) : i));
}

/** BUILD-ALL: mark every currently-buildable refinement as built. Pure. */
export function buildAll(list: Improvement[]): Improvement[] {
  return list.map((i) => (isBuildable(i) ? markBuilt(i) : i));
}

/**
 * DESIGN-&-BUILD convenience at the model level: run the design step (attach drafts to
 * every designable item) THEN the build step (mark all now-buildable items built), and
 * expose BOTH intermediate states so a caller/UI can show "designed, then built". Pure;
 * no side effects — the caller performs the real design/build, this yields the state
 * transitions in order.
 */
export function designThenBuild(
  list: Improvement[],
  draftFor: (imp: Improvement) => string,
): { designed: Improvement[]; built: Improvement[] } {
  const designed = designAll(list, draftFor);
  const built = buildAll(designed);
  return { designed, built };
}

// ------------------------------------------------------------------ mutations --

/** Remove a refinement by id (returns a new array). */
export function dropImprovement(improvements: Improvement[], id: string): Improvement[] {
  return improvements.filter((i) => i.id !== id);
}

/** The honest one-word label for a refinement's routing. */
export function kindLabel(kind: ImprovementKind): string {
  return kind === 'rebuild' ? 'rebuild' : 'needs design';
}

/** A short human label for a refinement's lifecycle state (for the UI). */
export function stateLabel(state: RefinementState): string {
  return state === 'built' ? 'built' : state === 'designed' ? 'designed' : 'proposed';
}

/** The human label for a Test dimension (for badges). */
export function dimensionLabel(d: RefinementDimension): string {
  switch (d) {
    case 'functionality': return 'Functionality';
    case 'ux': return 'User Experience';
    case 'code': return 'Code Structure';
    case 'security': return 'Security';
    case 'docs': return 'Documentation';
  }
}
