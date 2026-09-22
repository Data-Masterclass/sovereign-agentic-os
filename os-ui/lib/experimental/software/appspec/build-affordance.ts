/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The PURE decision for what the declarative Build stage must OFFER — extracted so the
 * "never an empty dead-end" contract is unit-testable on its own, independent of React.
 *
 * THE BUG THIS FIXES (cohort-blocking): a declarative app authored from epics + granted
 * context could land on Build with NOTHING to do. The composer only auto-generated when the
 * working draft was still the fresh single-tab default AND no `draftSpec`/`spec` had been
 * persisted yet; and it only showed a calm "point me to the missing piece" empty-state when
 * material was MISSING (no stories or no data). So the exact state "has stories + has data,
 * but a stale/partial `draftSpec` already got autosaved (e.g. a failed generate persisted the
 * default starter)" fell through BOTH: auto-generate was skipped (a draft exists) and the
 * empty-state was suppressed (material is present). In the default Simple mode the manual
 * "Reset based on Design" button is developer-only, so the user saw an empty, actionless
 * stage — the reported dead-end.
 *
 * The fix is to decide the affordance from HONEST inputs and ALWAYS resolve to something the
 * user can act on:
 *   • 'auto-generate'  — fresh app, material present, no saved work → fire the generator once.
 *   • 'offer-generate' — material present but the working draft is still empty/default (incl.
 *                        a stale autosaved default) → show a "Build from my design" button in
 *                        BOTH modes (this is the case that used to dead-end).
 *   • 'need-stories'   — no user stories yet → point to Design.
 *   • 'need-data'      — stories but no granted dataset → point to Choose Context.
 *   • 'editing'        — a real, non-default draft/spec exists → the composer/assistant drive it.
 */

export type BuildAffordanceInput = {
  /** ≥1 user story exists across the app's epics. */
  hasStories: boolean;
  /** ≥1 dataset is granted to the app. */
  hasData: boolean;
  /**
   * The working draft is still the fresh single-tab default (one records-table, no stories
   * linked, no custom block, no functions) AND there is no LIVE published spec — i.e. no real
   * app has been composed yet. A stale autosaved default draft is INCLUDED here (it round-trips
   * back to the default shape), which is precisely why it must offer generate, not dead-end.
   */
  atDefault: boolean;
  /** The generator is already running (auto-fired or user-pressed). */
  generating: boolean;
  /**
   * This mount already auto-fired the generator (the one-shot ref). Once true we never return
   * 'auto-generate' again — a second material app on the same mount offers the button instead.
   */
  autoFired: boolean;
  /**
   * A saved `draftSpec` or live `spec` was present on THIS mount. Auto-generate must never run
   * over saved work; when the saved work is the default starter the caller still gets
   * 'offer-generate' via `atDefault`, so no keystrokes are ever lost.
   */
  hasSavedWork: boolean;
};

export type BuildAffordance =
  | 'auto-generate'
  | 'offer-generate'
  | 'need-stories'
  | 'need-data'
  | 'editing';

/**
 * Resolve the single affordance the Build stage should present. Total (never undefined) and
 * pure. The order encodes the priority: a running generator or a real composed app short-circuit
 * first; then the material gates; then the fresh-app auto vs offer split.
 */
export function buildStageAffordance(input: BuildAffordanceInput): BuildAffordance {
  const { hasStories, hasData, atDefault, generating, autoFired, hasSavedWork } = input;

  // A real, non-default app is being edited — the composer + assistant drive it; no CTA needed.
  if (!atDefault) return 'editing';

  // At the default starter: what's missing, if anything?
  if (!hasStories) return 'need-stories';
  if (!hasData) return 'need-data';

  // Material is present and the draft is still the default. Auto-fire ONCE for a truly fresh app
  // (no saved work, not yet fired this mount); otherwise OFFER the button so a stale/partial
  // autosaved default — the dead-end case — always has a working path forward.
  if (generating) return 'auto-generate'; // the generate spinner surface owns the screen
  if (!hasSavedWork && !autoFired) return 'auto-generate';
  return 'offer-generate';
}

/** Should the one-shot auto-generate effect fire on this mount? Pure mirror of the effect guard. */
export function shouldAutoGenerate(input: BuildAffordanceInput): boolean {
  return buildStageAffordance({ ...input, generating: false }) === 'auto-generate';
}
