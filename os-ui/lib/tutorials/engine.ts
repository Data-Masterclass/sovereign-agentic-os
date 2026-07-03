/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The walk-through engine — PURE logic (no DOM, no React), so it is unit-tested
 * with `node --test`. The React coach-mark layer (`CoachMarks.tsx`) consumes
 * these functions; all the correctness-critical rules live here:
 *
 *   1. Role framing — map the session role → framing role → verb/hook/captions.
 *   2. Sandbox isolation — in practice mode, GOVERNED-WRITE steps are removed and
 *      every remaining step targets the personal/sandbox lane. A guard ASSERTS
 *      no governed write can leak into practice (the "no governed writes" proof).
 *   3. Anchor targeting — resolve which anchor a step points at for the active
 *      mode (sandbox vs real), keeping ids stable.
 *
 * RLS-safe by construction: the engine never performs an action — it only
 * decides which existing UI element to *highlight*. On the real tab OPA/RLS
 * still governs every click; in sandbox mode we only ever point at the lane.
 */

import type { Role } from '@/lib/session';
import type {
  FramingRole,
  Panel,
  TutorialDef,
  WalkMode,
  WalkStep,
} from './types';

/**
 * Map the app's session role → the tutorial framing role.
 *   creator → creator (a learner who builds drafts)
 *   builder     → builder  (also reviews / promotes in-domain)
 *   admin       → builder  (sees the review/promote framing too)
 * `undefined` (signed-out / unknown) → user (use/consume framing).
 */
export function framingForRole(role: Role | undefined | null): FramingRole {
  switch (role) {
    case 'creator':
      return 'creator';
    case 'builder':
    case 'admin':
      return 'builder';
    default:
      return 'user';
  }
}

/** The active step's anchor id for the given mode (sandbox falls back to real). */
export function targetAnchor(step: WalkStep, mode: WalkMode): string {
  if (mode === 'sandbox') return step.sandboxAnchor ?? step.anchor;
  return step.anchor;
}

/** Is a step visible for this framing role? (no `roles` ⇒ visible to all). */
export function stepVisibleForRole(step: WalkStep, role: FramingRole): boolean {
  return !step.roles || step.roles.includes(role);
}

/**
 * Resolve the ordered walk-through steps for a mode + role.
 *
 * Sandbox mode (practice) enforces isolation STRUCTURALLY, not by trusting the
 * author: it (1) drops every governed-write step — practice writes nothing real
 * — and (2) guarantees every surviving step targets the tab's personal/sandbox
 * lane. A step that declares no `sandboxAnchor` is coalesced onto the lane
 * anchor (`def.sandbox.anchor`), so a sandbox step can NEVER fall back to a
 * governed control regardless of how a tutorial was authored. Real mode keeps
 * all role-visible steps (governed, OPA/RLS applies).
 */
export function walkSteps(
  def: TutorialDef,
  mode: WalkMode,
  role: FramingRole,
): WalkStep[] {
  const byRole = def.walkthrough.filter((s) => stepVisibleForRole(s, role));
  if (mode === 'real') return byRole;
  return byRole
    .filter((s) => !s.governedWrite)
    .map((s) => (s.sandboxAnchor ? s : { ...s, sandboxAnchor: def.sandbox.anchor }));
}

/**
 * The practice-isolation invariant. Throws if any sandbox step (a) is a governed
 * write, or (b) lacks a sandbox target — either would let practice touch the
 * governed UI. Called on the output of `walkSteps(...,'sandbox',...)` by the
 * registry self-check and the tests: the proof that nothing persists to real
 * products during practice.
 */
export function assertSandboxSafe(steps: WalkStep[]): void {
  for (const s of steps) {
    if (s.governedWrite) {
      throw new Error(
        `sandbox walk-through must not contain governed-write step "${s.anchor}"`,
      );
    }
    if (!s.sandboxAnchor) {
      throw new Error(
        `sandbox walk-through step "${s.anchor}" has no sandbox target`,
      );
    }
  }
}

/** Does this tutorial expose a usable practice (sandbox) lane? */
export function hasSandbox(def: TutorialDef): boolean {
  return Boolean(def.sandbox?.anchor) && walkSteps(def, 'sandbox', 'user').length > 0;
}

/** Resolve a panel's caption for a framing role (role override or default). */
export function panelForRole(
  panel: Panel,
  role: FramingRole,
): { illustration: Panel['illustration']; title: string; body: string } {
  const o = panel.byRole?.[role];
  return {
    illustration: panel.illustration,
    title: o?.title ?? panel.title,
    body: o?.body ?? panel.body,
  };
}

/** The role's framing (verb + hook). Always defined for the three roles. */
export function framingFor(def: TutorialDef, role: FramingRole) {
  return def.framing[role];
}
