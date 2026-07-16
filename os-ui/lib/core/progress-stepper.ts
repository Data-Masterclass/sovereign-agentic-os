/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Pure state/geometry for the OS-wide <ProgressStepper> primitive (see
 * components/core/ProgressStepper.tsx). Kept framework-free so the pct math and the
 * per-step CSS-class mapping are unit-testable on their own — the React component is a
 * thin skin over these functions.
 *
 * The visual contract mirrors the original Agents "Build" stepper exactly:
 *   active → gold shimmer bar + a spinning dot; done → teal ✓; fail → red ✗; pending → number.
 */

export type StepState = 'pending' | 'active' | 'done' | 'fail';
export type Step = { key: string; label: string; state: StepState };

/**
 * Bar fill percentage from the steps. Progress is done-count / total, and — like the
 * Build stepper — it NEVER shows 100% until the whole run has settled (`done`). While a
 * run is in flight with nothing yet complete, a small floor keeps the bar visibly alive.
 * An explicit `pct` overrides the computation (still clamped, still capped below 100 until done).
 */
export function barPct(steps: Step[], opts: { active: boolean; done: boolean; pct?: number }): number {
  const total = steps.length;
  const doneCount = steps.filter((s) => s.state === 'done').length;
  if (opts.done) return 100;
  const raw = opts.pct ?? (total > 0 ? (doneCount / total) * 100 : 0);
  // While in flight, show at least a sliver so the bar reads as "working"; never reach 100.
  const floor = opts.active ? 6 : 0;
  return Math.max(floor, Math.min(96, Math.round(raw)));
}

/** The bar-fill state suffix classes: shimmer while active, teal on ok-done, red on fail-done. */
export function barFillClasses(opts: { active: boolean; done: boolean; ok: boolean }): string {
  const parts: string[] = [];
  if (opts.active) parts.push('animating');
  if (opts.done && opts.ok) parts.push('ok');
  if (opts.done && !opts.ok) parts.push('fail');
  return parts.join(' ');
}

/** The <li> state suffix classes for one step. */
export function stepClasses(state: StepState): string {
  if (state === 'active') return 'active';
  if (state === 'done') return 'done';
  if (state === 'fail') return 'fail';
  return '';
}

/** The dot glyph for a step: ✓ done, ✗ fail, 'spin' sentinel for active, else the 1-based number. */
export function stepDotGlyph(state: StepState, index: number): '✓' | '✗' | 'spin' | number {
  if (state === 'fail') return '✗';
  if (state === 'done') return '✓';
  if (state === 'active') return 'spin';
  return index + 1;
}
