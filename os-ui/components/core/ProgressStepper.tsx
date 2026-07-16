/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * ProgressStepper — the ONE fancy in-flight progress primitive for the whole OS.
 *
 * A determinate bar over an ordered stepper: each step is active (gold shimmer bar + a
 * spinning dot), done (teal ✓), fail (red ✗) or pending (its number). It was extracted
 * verbatim from the Agents "Build" stepper so any long-running OS operation — building a
 * team, running a team, a data pipeline, a dashboard refresh — wears the same calm,
 * Apple-grade progress UX. Purely presentational: callers own the state and just hand it
 * a `steps[]` list plus the settle flags. The pct math + class mapping live in
 * lib/core/progress-stepper.ts so they can be unit-tested away from React.
 */

import {
  barPct,
  barFillClasses,
  stepClasses,
  stepDotGlyph,
  type Step,
} from '@/lib/core/progress-stepper';

export type { Step, StepState } from '@/lib/core/progress-stepper';

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
