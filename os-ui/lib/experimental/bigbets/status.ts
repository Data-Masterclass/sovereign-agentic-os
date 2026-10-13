/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Status-derivation adapter (Opus spine).
 *
 * The bet NEVER stores a component's status. We read each referenced artifact's
 * real per-tab lifecycle and DERIVE planned / in-progress / completed from the
 * golden-path table:
 *
 *   | tab        | planned     | in-progress              | completed (ready)        |
 *   | data       | not created | building / draft / fail  | certified / promoted     |
 *   | metric     | not defined | defined, not promoted    | promoted / certified     |
 *   | dashboard  | not created | draft                    | published / promoted     |
 *   | software   | not created | building / sandbox       | deployed (Builder)       |
 *   | agent      | not created | draft / unpublished      | published + live         |
 *   | ml         | not created | training / Staging       | go-live to Production    |
 *   | knowledge  | not added   | drafting / indexing      | published                |
 *   | files      | not added   | drafting / indexing      | published                |
 *   | connection | not added   | added, untested          | tested + governed        |
 *
 * The owner override is shown BESIDE the derived state (never replacing it).
 * A component is `blocked` when a build-order dependency is not yet completed —
 * that is a roadmap signal computed here from the derived states, so a blocked
 * component reads "planned · blocked", honest about both facts at once.
 */

import { type ComponentRef, type DerivedStatus, type Lifecycle } from './model.ts';
import { resolveArtifact } from './sources.ts';

const IN_PROGRESS: Lifecycle[] = ['building', 'draft', 'staging', 'untested'];

/** Pure mapping: a raw lifecycle token → the derived three-state. */
export function deriveStatus(lifecycle: Lifecycle | null | undefined): DerivedStatus {
  if (!lifecycle || lifecycle === 'planned') return 'planned';
  if (IN_PROGRESS.includes(lifecycle)) return 'in-progress';
  return 'completed'; // every ready token (certified/promoted/published/…)
}

export type ComponentStatus = {
  refId: string;
  artifactId: string;
  /** The authoritative, auto-derived state from the real lifecycle. */
  derived: DerivedStatus;
  lifecycle: Lifecycle | null;
  /** True when a dependency is not yet completed (build order not satisfied). */
  blocked: boolean;
  /** Which dependency ref ids are holding this one back. */
  blockedBy: string[];
  /** The owner's annotation, shown beside `derived` — informational, audited. */
  override?: ComponentRef['override'];
  /** A short, honest label: "completed", "planned · blocked", etc. */
  label: string;
};

/**
 * Derive every component's status for a bet, dependency-aware. Two passes: first
 * each component's own derived state, then the blocked flag from its deps.
 */
export function deriveBet(components: ComponentRef[]): ComponentStatus[] {
  const byRef = new Map<string, DerivedStatus>();
  const lifecycleByRef = new Map<string, Lifecycle | null>();

  for (const c of components) {
    const art = resolveArtifact(c.artifactId);
    const lc = art ? art.lifecycle : null;
    lifecycleByRef.set(c.id, lc);
    byRef.set(c.id, deriveStatus(lc));
  }

  return components.map((c) => {
    const derived = byRef.get(c.id) ?? 'planned';
    const blockedBy = c.dependsOn.filter((dep) => byRef.get(dep) !== 'completed');
    // A finished component is never "blocked" (the build already happened).
    const blocked = derived !== 'completed' && blockedBy.length > 0;
    const parts: string[] = [derived];
    if (blocked) parts.push('blocked');
    return {
      refId: c.id,
      artifactId: c.artifactId,
      derived,
      lifecycle: lifecycleByRef.get(c.id) ?? null,
      blocked,
      blockedBy,
      override: c.override,
      label: parts.join(' · '),
    };
  });
}

/** Roll the per-component derived states into a single bet completion ratio. */
export function completion(statuses: ComponentStatus[]): {
  done: number;
  total: number;
  pct: number;
} {
  const total = statuses.length;
  const done = statuses.filter((s) => s.derived === 'completed').length;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}
