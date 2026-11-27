/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    StageShell — the numbered stepper rail and stage chrome for guided builders
 * USER STORY: As a builder in a guided flow I want a numbered rail that shows which stages are
 *             done, need a look, or failed, and stops me jumping ahead too early, so that I
 *             always know where I am.
 * ARCHITECTURE:
 *   - Controlled and presentational. The tab owns a `StageState` and derives `ctx` each render.
 *     All gating, ✓ and advance rules are in `@core/kernel/stages` (unit-tested, no React).
 *     Taken from the Agents guided builder. It renders the existing `.sb-step*` classes from
 *     `app/globals.css`.
 *   - A step badge describes the stage's work, not which buttons were pressed, so it is the same
 *     after a reload: ✓ done, ! needs a look, ✕ last attempt failed, n not done. Each state is
 *     also in the tooltip and aria label.
 *   - Render order: rail (+ `aside`), then the optional header, the body, the optional
 *     `assistant` slot and the optional back/next nav. Agents turns off the header and nav.
 *   - The component is rendered by Agents (SimpleBuilder), Software and Connections (Expose).
 *     Data and Metrics use the kernel stage rules, not this component.
 * I18N:       converted (wave 4) — the rail's own words from `common.stage.*` (./stage-shell-labels.ts); stage
 *             titles, hints and the tabs' problem / pending lines are the caller's, already translated.
 */
'use client';

import type { ReactNode } from 'react';
import { useCommonMessage } from '@core/ui/useScopeLabel';
import { nextHintMessage, stageLabelMessage, stageStateWord, stepAriaMessage } from '@core/ui/core/stage-shell-labels';
import {
  advance, canEnter, goTo, nextStageId, prevStageId, retreat,
  stageDefOf, stageStatuses,
  type StageDef, type StageMark, type StageState,
} from '@core/kernel/stages';

/** The glyph a step badge shows for each mark (`todo` shows the step number instead). */
const MARK_GLYPH: Record<Exclude<StageMark, 'todo'>, string> = { done: '✓', warn: '!', error: '✕' };

export type { StageDef, StageState } from '@core/kernel/stages';

/** Navigation + progress helpers handed to a render-prop body (for bespoke footers). */
export type StageApi<Id extends string = string> = {
  /** The stage currently on screen. */
  stageId: Id;
  /** Step back one stage. */
  back: () => void;
  /** Step forward one stage (a no-op while the next stage is gated). */
  next: () => void;
  /** Is the next stage enterable right now (drives disabled-until-ready)? */
  canNext: boolean;
  /** Jump to any enterable stage. */
  goTo: (id: Id) => void;
};

export default function StageShell<Id extends string, Ctx>({
  stages,
  state,
  ctx,
  onState,
  ariaLabel,
  aside,
  showHeader = true,
  showNav = true,
  hideNextFor,
  assistant,
  children,
}: {
  /** The ordered stage definitions (ids, titles, hints, gates, conditions). */
  stages: readonly StageDef<Id, Ctx>[];
  /** The position the tab owns (the stage on screen). */
  state: StageState<Id>;
  /** The artifact's current state, as the gates/conditions read it — derive it fresh each render. */
  ctx: Ctx;
  /** Receive every transition (wire straight to the tab's setState). */
  onState: (next: StageState<Id>) => void;
  /** Accessible label for the stepper rail. */
  ariaLabel?: string;
  /** Optional content on the rail row's right (e.g. a runtime badge). */
  aside?: ReactNode;
  /** Render the standard stage header (title + one-line hint). Off for bespoke headers. */
  showHeader?: boolean;
  /** Render the standard back/next footer. Off for bespoke per-stage footers. */
  showNav?: boolean;
  /** Stages whose FORWARD nav is hidden because the stage body owns its own
   *  "Continue" (shown after the stage's real work succeeds) — a bare "next →"
   *  there reads as the primary action but does nothing. Back nav stays; the
   *  rail keeps every stage voluntarily reachable. */
  hideNextFor?: readonly Id[];
  /** Optional per-stage assistant slot — mount a stage-scoped helper here. */
  assistant?: (stage: StageDef<Id, Ctx>) => ReactNode;
  /** The stage body — plain nodes, or a render prop receiving the nav helpers. */
  children: ReactNode | ((api: StageApi<Id>) => ReactNode);
}) {
  const text = useCommonMessage();
  const rail = stageStatuses(stages, state, ctx);
  const current = stageDefOf(stages, state.current) ?? stages[0];
  const nextId = nextStageId(stages, state.current);
  const prevDef = ((id) => (id ? stageDefOf(stages, id) : undefined))(prevStageId(stages, state.current));
  const nextDef = nextId ? stageDefOf(stages, nextId) : undefined;

  const api: StageApi<Id> = {
    stageId: state.current,
    back: () => onState(retreat(stages, state, ctx)),
    next: () => onState(advance(stages, state, ctx)),
    canNext: !!nextId && canEnter(stages, nextId, ctx),
    goTo: (id) => onState(goTo(stages, state, id, ctx)),
  };

  const nextHidden = !!hideNextFor?.includes(state.current);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <ol className="sb-steps" aria-label={ariaLabel ?? text({ key: 'stage.railAria' })} style={{ marginBottom: 0 }}>
          {rail.map((st) => {
            const label = text(stageLabelMessage(st.title, text(stageStateWord(st.state))));
            return (
            <li key={st.id} className={`sb-step${st.active ? ' active' : ''}${st.mark === 'todo' ? '' : ` ${st.mark}`}`}>
              <button
                type="button"
                onClick={() => api.goTo(st.id)}
                disabled={!st.enabled}
                title={label}
                aria-label={text(stepAriaMessage(st.index, label))}
                aria-current={st.active ? 'step' : undefined}
              >
                <span className="sb-step-n" aria-hidden="true">{st.mark === 'todo' ? st.index + 1 : MARK_GLYPH[st.mark]}</span>
                <span className="sb-step-label">{st.title}</span>
              </button>
            </li>
            );
          })}
        </ol>
        {aside}
      </div>

      {showHeader ? (
        <>
          <h2 className="sb-section-title" style={{ marginTop: 0 }}>{current.title}</h2>
          {current.hint ? <p className="hint" style={{ marginTop: 0 }}>{current.hint}</p> : null}
        </>
      ) : null}

      {typeof children === 'function' ? children(api) : children}

      {assistant ? assistant(current) : null}

      {showNav && (prevDef || (nextDef && !nextHidden)) ? (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          {prevDef ? (
            <button className="btn ghost sm" onClick={api.back}>← {prevDef.title}</button>
          ) : <span />}
          {nextDef && !nextHidden ? (
            <button
              className="btn"
              onClick={api.next}
              disabled={!api.canNext}
              title={text(nextHintMessage(api.canNext, nextDef.title, current.title))}
            >
              {nextDef.title} →
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
