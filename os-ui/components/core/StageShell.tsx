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
 * Purely presentational + controlled: the tab owns a `StageState` (usually one
 * `useState`), derives a fresh `ctx` each render, and hands both here. All gating,
 * ✓ and advance rules live in lib/core/stages.ts (unit-tested, no React).
 *
 * Render order: rail (+ optional `aside` on its right) → optional standard stage
 * header (title + one-line hint) → body → optional per-stage `assistant` slot →
 * optional standard back/next nav. Tabs with bespoke per-stage headers/footers
 * (like Agents) pass `showHeader={false} showNav={false}` and keep their own.
 */

import type { ReactNode } from 'react';
import {
  advance, canEnter, goTo, markDone, nextStageId, prevStageId, retreat,
  stageDefOf, stageStatuses,
  type StageDef, type StageState,
} from '@/lib/core/stages';

export type { StageDef, StageState } from '@/lib/core/stages';

/** Navigation + progress helpers handed to a render-prop body (for bespoke footers). */
export type StageApi<Id extends string = string> = {
  /** The stage currently on screen. */
  stageId: Id;
  /** Step back one stage. */
  back: () => void;
  /** Step forward one stage — records the current stage's ✓ when its condition is met. */
  next: () => void;
  /** Is the next stage enterable right now (drives disabled-until-ready)? */
  canNext: boolean;
  /** Jump to any enterable stage. */
  goTo: (id: Id) => void;
  /** Record a stage as completed this session (for work that settles in-stage). */
  markDone: (id: Id) => void;
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
  assistant,
  children,
}: {
  /** The ordered stage definitions (ids, titles, hints, gates, conditions). */
  stages: readonly StageDef<Id, Ctx>[];
  /** The session stage state the tab owns (current stage + done-set). */
  state: StageState<Id>;
  /** The live context the gates/conditions read — derive it fresh each render. */
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
    markDone: (id) => onState(markDone(state, id)),
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <ol className="sb-steps" aria-label={ariaLabel} style={{ marginBottom: 0 }}>
          {rail.map((st) => (
            <li key={st.id} className={`sb-step${st.active ? ' active' : ''}${st.done ? ' done' : ''}`}>
              <button type="button" onClick={() => api.goTo(st.id)} disabled={!st.enabled}>
                <span className="sb-step-n">{st.done ? '✓' : st.index + 1}</span>
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

      {showNav && (prevDef || nextDef) ? (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          {prevDef ? (
            <button className="btn ghost sm" onClick={api.back}>← {prevDef.title}</button>
          ) : <span />}
          {nextDef ? (
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
