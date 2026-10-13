/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Workflow, type WorkflowStep, type StepLink, type LinkType } from './schema.ts';

/**
 * Gap detection — pure. A step link that references an entity which doesn't exist
 * yet is a GAP: the workflow flags it and offers a jump-to-build (carrying the
 * workflow context), but NEVER auto-creates anything (locked decision).
 *
 * Entity existence is resolved by an injected `known` set per link type, so this
 * stays pure + testable; the live resolver (data products / apps / agents / files
 * registries) is mocked in kind and passed in by the caller.
 */

export type EntityIndex = {
  data: Set<string>;
  app: Set<string>;
  agent: Set<string>;
  file: Set<string>;
};

export type Gap = {
  stepId: string;
  stepTitle: string;
  link: StepLink;
  /** The tab to jump to in order to build the missing entity. */
  buildTab: 'data' | 'software' | 'agents' | 'unstructured';
  /** Deep-link URL (carries the workflow id + the wanted ref as context). */
  buildHref: string;
};

/** Which tab builds each link type. */
const LINK_TAB: Record<LinkType, Gap['buildTab']> = {
  data: 'data',
  app: 'software',
  agent: 'agents',
  file: 'unstructured',
};

function emptyIndex(): EntityIndex {
  return { data: new Set(), app: new Set(), agent: new Set(), file: new Set() };
}

/** True when the link's target is missing from the entity index. */
export function isGap(link: StepLink, index: EntityIndex): boolean {
  const set = index[link.type];
  return !set.has(link.ref);
}

/** Count a single step's gaps (used by the swimlane layout's `gapFor`). */
export function stepGapCount(step: WorkflowStep, index: EntityIndex): number {
  return step.links.reduce((n, l) => n + (isGap(l, index) ? 1 : 0), 0);
}

/** Find every gap in a workflow, with a jump-to-build target for each. */
export function findGaps(workflow: Workflow, index: EntityIndex = emptyIndex()): Gap[] {
  const gaps: Gap[] = [];
  for (const step of workflow.steps) {
    for (const link of step.links) {
      if (!isGap(link, index)) continue;
      const buildTab = LINK_TAB[link.type];
      const params = new URLSearchParams({
        from: 'knowledge',
        workflow: workflow.id,
        ref: link.ref,
        ...(link.label ? { label: link.label } : {}),
      });
      gaps.push({
        stepId: step.id,
        stepTitle: step.title,
        link,
        buildTab,
        buildHref: `/${buildTab}?${params.toString()}`,
      });
    }
  }
  return gaps;
}
