/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * build-progress — derive the live BUILD stepper (pure, unit-tested) for the core
 * ProgressStepper, so a build RUN visibly shows itself building instead of a silent
 * spinner ("it doesn't show that it is building"). Framework-free so it's testable away
 * from React; the BuildChat is a thin skin over this.
 *
 * The four ordered steps of a Build run: Plan → Generate → Commit → Preview. We infer
 * each step's state from the same live signals the chat already has — whether a plan has
 * streamed, how many activity lines have landed, whether the terminal changeset committed,
 * and whether a preview URL followed — never a timer, never faked.
 */

import type { Step, StepState } from '@/lib/core/progress-stepper';

/** The live signals of an in-flight (or just-finished) build run. */
export type BuildRunSignals = {
  /** A run is streaming right now. */
  running: boolean;
  /** The plan text has started streaming. */
  hasPlan: boolean;
  /** How many governed activity lines have landed so far. */
  activityCount: number;
  /** Files were committed by this run (the terminal changeset had changes). */
  committed: boolean;
  /** A preview URL is being served for this app. */
  previewed: boolean;
  /** The run ended in error. */
  failed: boolean;
};

const BUILD_STEP_LABELS: { key: string; label: string }[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'generate', label: 'Generate' },
  { key: 'commit', label: 'Commit' },
  { key: 'preview', label: 'Preview' },
];

/**
 * Derive the ordered build steps + settle flags for ProgressStepper from the live signals.
 * At most one step is 'active' (the frontier); everything before it is 'done'. On failure
 * the frontier step is marked 'fail'. When nothing is in flight and nothing has happened,
 * every step is 'pending' (the stepper is inert).
 */
export function deriveBuildProgress(sig: BuildRunSignals): {
  steps: Step[];
  active: boolean;
  done: boolean;
  ok: boolean;
} {
  // How many steps have PROVABLY completed. Entry into a later step ⇒ the earlier one
  // finished: generation starting (activity) ⇒ Plan done; a commit ⇒ Generate + Commit
  // done; a served preview ⇒ Preview done. `hasPlan` alone does NOT complete Plan (the
  // plan is still streaming), so Plan stays the active frontier until generation begins.
  let completed = 0;
  if (sig.activityCount > 0) completed = 1; // Plan done, Generate is the frontier
  if (sig.committed) completed = 3;         // Generate + Commit done, Preview is the frontier
  if (sig.previewed) completed = 4;         // everything done

  const active = sig.running && !sig.failed;
  const anyProgress = sig.hasPlan || sig.activityCount > 0 || sig.committed || sig.previewed;
  // Settled once the run stops (or fails). Idle-with-no-progress is NOT "done".
  const settled = !sig.running && (sig.failed || anyProgress);
  const ok = !sig.failed;

  const steps: Step[] = BUILD_STEP_LABELS.map((s, i) => {
    let state: StepState;
    if (i < completed) {
      // Provably finished.
      state = 'done';
    } else if (i === completed) {
      // The frontier step — the one in progress (or where a failure/settle lands).
      // On a clean SETTLE it's 'done' only when the run actually reached/worked this exact
      // step; otherwise it never ran and stays 'pending'. Plan is reached once a plan
      // streamed; the Preview frontier is only reached when a preview was served (which
      // would push `completed` to 4), so a committed-but-un-previewed build leaves Preview
      // pending rather than force-greening a step that didn't happen.
      const reachedFrontier =
        s.key === 'plan' ? sig.hasPlan :
        s.key === 'preview' ? sig.previewed :
        true;
      if (sig.failed) state = 'fail';
      else if (active) state = 'active';
      else if (settled && reachedFrontier) state = 'done';
      else state = 'pending';
    } else {
      // Beyond the frontier — pending (a build that committed without a preview simply
      // never reached Preview; we never force-green a step that didn't run).
      state = 'pending';
    }
    return { key: s.key, label: s.label, state };
  });

  return { steps, active, done: settled, ok };
}
