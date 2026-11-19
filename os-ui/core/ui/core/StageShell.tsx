/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * StageShell — the ONE staged-builder chrome for the whole OS.
 *
 * The numbered stepper rail with ✓ marks and gated navigation, extracted verbatim
 * from the Agents guided builder (Define · Design · Build · Run · Evaluate) so every
 * tab's guided path — Data, Metrics, Dashboards, Science, Software — wears the same
 * calm, Apple-grade staged UX. It renders the exact `.sb-step*` classes the Agents
 * rail always used (see "guided step rail" in app/globals.css), so old and new look
 * byte-identical with zero new CSS.
 *
 * Purely presentational + controlled: the tab owns a `StageState` (the position —
 * usually one `useState`), derives a fresh `ctx` each render from the artifact's
 * current state, and hands both here. All gating, ✓ and advance rules live in
 * core/kernel/stages.ts (unit-tested, no React).
 *
 * What a step's badge means — always about the WORK, never about which buttons were
 * pressed, so it is identical after a reload and for every viewer:
 *   ✓ (teal)  the stage's work is done          ! (gold)  it needs a look
 *   ✕ (red)   its last attempt failed           n         not done yet
 * Each state is also spelled out in the button's tooltip and accessible label
 * ("Grant: done", "Grant: nothing granted yet"), so it never rides on colour alone.
 *
 * Render order: rail (+ optional `aside` on its right) → optional standard stage
 * header (title + one-line hint) → body → optional per-stage `assistant` slot →
 * optional standard back/next nav. Tabs with bespoke per-stage headers/footers
 * (like Agents) pass `showHeader={false} showNav={false}` and keep their own.
 */

import type { ReactNode } from 'react';
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
  ariaLabel = 'Stages',
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
        <ol className="sb-steps" aria-label={ariaLabel} style={{ marginBottom: 0 }}>
          {rail.map((st) => (
            <li key={st.id} className={`sb-step${st.active ? ' active' : ''}${st.mark === 'todo' ? '' : ` ${st.mark}`}`}>
              <button
                type="button"
                onClick={() => api.goTo(st.id)}
                disabled={!st.enabled}
                title={st.label}
                aria-label={`Step ${st.index + 1} — ${st.label}`}
                aria-current={st.active ? 'step' : undefined}
              >
                <span className="sb-step-n" aria-hidden="true">{st.mark === 'todo' ? st.index + 1 : MARK_GLYPH[st.mark]}</span>
                <span className="sb-step-label">{st.title}</span>
              </button>
            </li>
          ))}
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
              title={api.canNext ? `Continue to ${nextDef.title}` : `Finish ${current.title} first`}
            >
              {nextDef.title} →
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
