/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    ProgressStepper — the shared progress bar and ordered step list for long operations
 * USER STORY: As a user waiting on a build, run or pipeline I want a progress bar and a list of
 *             steps (active, done, failed, pending) so that I can see how far it has got.
 * ARCHITECTURE:
 *   - Presentational. The caller owns the state and passes `steps[]` plus `active`, `done` and
 *     `ok`. Taken from the Agents "Build" stepper.
 *   - The percentage math and class mapping are in `@core/kernel/progress-stepper` so they can be
 *     unit-tested without React.
 *   - Used by `BusyProgress`, `tabs/agents/ui/BuildRunPanel.tsx` and `tabs/software/ui/BuildChat.tsx`.
 */
'use client';

import {
  barPct,
  barFillClasses,
  stepClasses,
  stepDotGlyph,
  type Step,
} from '@core/kernel/progress-stepper';

export type { Step, StepState } from '@core/kernel/progress-stepper';

export default function ProgressStepper({
  steps,
  active,
  done = false,
  ok = true,
  pct,
  commentary,
}: {
  /** The ordered steps and their live states. */
  steps: Step[];
  /** Something is in flight → the bar shimmers. */
  active: boolean;
  /** The whole operation has settled → the bar reaches 100% and holds its final colour. */
  done?: boolean;
  /** On settle, did it succeed (teal) or fail (red)? */
  ok?: boolean;
  /** Optional explicit bar percentage; otherwise derived from done-count / total. */
  pct?: number;
  /** An optional live "what is happening right now" sentence, announced politely. */
  commentary?: string;
}) {
  const width = barPct(steps, { active, done, pct });
  const fillCls = barFillClasses({ active, done, ok });

  return (
    <div className="progress-stepper" aria-live="polite" style={{ marginTop: 8, marginBottom: 8 }}>
      <div className="ps-bar" role="progressbar" aria-valuenow={width} aria-valuemin={0} aria-valuemax={100}>
        <div className={`ps-bar-fill${fillCls ? ` ${fillCls}` : ''}`} style={{ width: `${width}%` }} />
      </div>
      {commentary ? (
        <div className="ps-commentary" aria-live="polite">{commentary}</div>
      ) : null}
      <ol className="ps-steps">
        {steps.map((st, i) => {
          const glyph = stepDotGlyph(st.state, i);
          return (
            <li key={st.key} className={`ps-step${stepClasses(st.state) ? ` ${stepClasses(st.state)}` : ''}`}>
              <span className="ps-dot" aria-hidden>
                {glyph === 'spin' ? <span className="spin" /> : glyph}
              </span>
              <span className="ps-label">{st.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
