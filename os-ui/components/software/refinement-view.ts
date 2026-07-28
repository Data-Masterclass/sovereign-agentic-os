/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * refinement-view — the PURE view-adapter for the refinement lifecycle UI (unit-tested,
 * framework-free). It consumes the foundation model (lib/software/improvements.ts) and
 * derives exactly what the RefinementList component needs to RENDER the same list across
 * Test · Design · Build with consistent Proposed → Designed → Built badges.
 *
 * It owns NO model logic — every state test/transition comes from the foundation
 * (isBuildable / isDesignable / markDesigned / markBuilt / …). This adapter only:
 *   • groups the list into to-design / to-build / done "lanes" for a stage,
 *   • decides which per-item actions a row should offer (Design · Build · Design & Build),
 *   • enforces the 8-feature batch cap on "Build all" (the same cap the tree uses),
 *   • maps a state/dimension to its badge classes.
 * Keeping this here (not in lib/software) respects the foundation boundary while still
 * being testable away from React.
 */

import {
  isBuildable,
  isDesignable,
  refinementState,
  refinementsToDesign,
  refinementsToBuild,
  type Improvement,
  type RefinementState,
  type RefinementDimension,
} from '@/lib/software/improvements';

/** The one-press action a refinement row can offer (mapped from the model state). */
export type RefineAction = 'design' | 'build' | 'designAndBuild';

/**
 * The actions a single refinement offers RIGHT NOW, in the order they should render:
 *   • a still-'proposed' design-kind item → Design + the Design & Build accelerator;
 *   • a buildable item (rebuild-proposed, or designed) → Build;
 *   • a 'built' item → nothing (it's done, shown for transparency).
 * The two-step (Design, then Build) is always the primary path; Design & Build is the
 * secondary accelerator that chains both while still surfacing the design output.
 */
export function actionsFor(imp: Improvement): RefineAction[] {
  if (refinementState(imp) === 'built') return [];
  if (isDesignable(imp)) return ['design', 'designAndBuild'];
  if (isBuildable(imp)) return ['build'];
  return [];
}

/** The three lanes a stage groups refinements into (done items are always retained). */
export type RefinementLanes = {
  /** Items that still need a Design pass (isDesignable). */
  toDesign: Improvement[];
  /** Items ready to build now (isBuildable) — the design-before-build gate applied. */
  toBuild: Improvement[];
  /** Completed ('built') items — kept visible everywhere for transparency. */
  done: Improvement[];
};

/** Group a refinement list into its Design / Build / Done lanes. */
export function lanesFor(list: Improvement[]): RefinementLanes {
  return {
    toDesign: refinementsToDesign(list),
    toBuild: refinementsToBuild(list),
    done: list.filter((i) => refinementState(i) === 'built'),
  };
}

/** How many refinements would "Build all" act on now — capped for a reliable batch. */
export const REFINE_BUILD_CAP = 8;

/**
 * The refinements a single "Build all" press should act on: every currently-buildable
 * item, capped at REFINE_BUILD_CAP so each batch stays reviewable (mirrors the feature
 * batch cap). The remainder is left for the next press — honest, never silently dropped.
 */
export function buildableBatch(list: Improvement[], cap: number = REFINE_BUILD_CAP): Improvement[] {
  return refinementsToBuild(list).slice(0, cap);
}

/** True when a "Build all" batch is cap-limited (more buildable items remain after it). */
export function buildBatchCapped(list: Improvement[], cap: number = REFINE_BUILD_CAP): boolean {
  return refinementsToBuild(list).length > cap;
}

/** The badge class for a lifecycle state (proposed = muted, designed = gold, built = ok). */
export function stateBadgeClass(state: RefinementState): string {
  if (state === 'built') return 'badge ok';
  if (state === 'designed') return 'badge warn';
  return 'badge muted';
}

/** A short dimension tag (2-3 letters) for the compact per-row badge. */
export function dimensionTag(d: RefinementDimension): string {
  switch (d) {
    case 'functionality': return 'FN';
    case 'ux': return 'UX';
    case 'code': return 'CODE';
    case 'security': return 'SEC';
    case 'docs': return 'DOC';
  }
}
