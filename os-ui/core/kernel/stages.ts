/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The OS-wide STAGED-BUILDER model — the pure state machine behind every tab's
 * guided path (Agents Define · Design · Build · Run · Evaluate was the original;
 * Data, Metrics, Dashboards, Science and Software adopt the same shape). The React
 * skin lives in components/core/StageShell.tsx; this file is framework-free so the
 * gating and ✓-mark rules are unit-testable on their own.
 *
 * The contract:
 *  • Stages form an ordered path. Each stage may gate entry (`enabled(ctx)`) and
 *    declares when its work is genuinely done (`completed(ctx)`).
 *  • A ✓ is a statement about the WORK, never about navigation. A stage shows ✓
 *    exactly when `completed(ctx)` holds for the artifact's current state — on first
 *    open, after a reload, after jumping between stages, and for a colleague opening
 *    the same artifact. It clears the moment the work is invalidated (e.g. every agent
 *    is deleted). Which buttons were pressed this session plays no part.
 *  • So `completed` must describe REAL work the stage exists for. A condition that
 *    merely repeats an earlier stage's (or "it has a name") would tick a stage nobody
 *    worked — that is the one way to fake a ✓ under this rule, and it is a bug in the
 *    stage definition.
 *  • A stage that is not done may name a specific `problem(ctx)` (a failed build, a
 *    grant that matches nothing). The rail then shows that instead of a bare number.
 *    A problem outranks ✓: a stage with a known problem is never painted green.
 *
 * History: until 2026-11 a ✓ also required the stage to have been "worked this
 * session" (a session `done` set, filled by advancing past a stage). That was meant
 * to stop un-earned ticks, but it tied the tick to button presses: granting context
 * and leaving by the rail recorded nothing, and every reload wiped all ticks from a
 * finished artifact. The session set is gone; `StageState` is only the position.
 */

/** One stage of a guided path. `Ctx` is whatever live state the tab derives per render. */
export type StageDef<Id extends string = string, Ctx = unknown> = {
  id: Id;
  /** The stepper label, e.g. "Define". */
  title: string;
  /** One line: what the user does here. Shown by StageShell's standard header. */
  hint?: string;
  /** May the user enter this stage now? Omitted → always reachable. */
  enabled?: (ctx: Ctx) => boolean;
  /**
   * Is this stage's work done, judged from the artifact's current state? Omitted → never.
   * Must describe the work THIS stage exists for (see the contract above).
   */
  completed?: (ctx: Ctx) => boolean;
  /** A specific thing wrong with this stage right now, or null. Outranks ✓. */
  problem?: (ctx: Ctx) => StageProblem | null | undefined;
  /** What is still missing, in a few plain words ("nothing granted yet"). Shown as the
   *  rail tooltip / accessible label while the stage is neither done nor in trouble. */
  pending?: (ctx: Ctx) => string | null | undefined;
};

/** Something specific wrong with a stage: `warn` = needs a look, `error` = it failed. */
export type StageProblem = { tone: 'warn' | 'error'; label: string };

/** What the rail paints for one stage. */
export type StageMark = 'done' | 'warn' | 'error' | 'todo';

/**
 * Where the user is on the path. Immutable — every transition returns a new value.
 * It holds NO progress: ✓ marks are derived from the artifact's state each render.
 */
export type StageState<Id extends string = string> = {
  /** The stage currently on screen. */
  current: Id;
};

/** Open on the first stage. Throws on an empty stage list. */
export function initialStageState<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
): StageState<Id> {
  const first = stages[0];
  if (!first) throw new Error('initialStageState: stages must not be empty');
  return { current: first.id };
}

/** The stage definition for an id, or undefined. */
export function stageDefOf<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
): StageDef<Id, Ctx> | undefined {
  return stages.find((s) => s.id === id);
}

/** May the user enter this stage now? Unknown ids are never enterable. */
export function canEnter<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
  ctx: Ctx,
): boolean {
  const def = stageDefOf(stages, id);
  if (!def) return false;
  return def.enabled ? def.enabled(ctx) : true;
}

/** Does the stage's completion condition hold for the artifact's current state? */
export function isSatisfied<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
  ctx: Ctx,
): boolean {
  return stageDefOf(stages, id)?.completed?.(ctx) ?? false;
}

/** The specific problem a stage reports right now, or null. */
export function stageProblem<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
  ctx: Ctx,
): StageProblem | null {
  return stageDefOf(stages, id)?.problem?.(ctx) ?? null;
}

/**
 * Does the stage show a ✓? Exactly when its work is done and nothing is wrong with it —
 * a pure function of the artifact's state, so it is the same on first open, after a
 * reload and for every viewer.
 */
export function isDone<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
  ctx: Ctx,
): boolean {
  return isSatisfied(stages, id, ctx) && !stageProblem(stages, id, ctx);
}

/** Jump to a stage — a no-op unless the stage is enterable right now. */
export function goTo<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  state: StageState<Id>,
  id: Id,
  ctx: Ctx,
): StageState<Id> {
  if (!canEnter(stages, id, ctx)) return state;
  if (state.current === id) return state;
  return { ...state, current: id };
}

/** The id after `id` on the path, or null at the end (or for an unknown id). */
export function nextStageId<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
): Id | null {
  const i = stages.findIndex((s) => s.id === id);
  return i >= 0 && i + 1 < stages.length ? stages[i + 1].id : null;
}

/** The id before `id` on the path, or null at the start (or for an unknown id). */
export function prevStageId<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
): Id | null {
  const i = stages.findIndex((s) => s.id === id);
  return i > 0 ? stages[i - 1].id : null;
}

/**
 * Move forward one stage: a no-op unless the NEXT stage is enterable. Moving records
 * nothing — a stage left unfinished stays un-ticked because its condition is unmet.
 */
export function advance<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  state: StageState<Id>,
  ctx: Ctx,
): StageState<Id> {
  const next = nextStageId(stages, state.current);
  if (!next || !canEnter(stages, next, ctx)) return state;
  return { ...state, current: next };
}

/** Move back one stage (gated like any entry) — a no-op at the start. */
export function retreat<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  state: StageState<Id>,
  ctx: Ctx,
): StageState<Id> {
  const prev = prevStageId(stages, state.current);
  return prev ? goTo(stages, state, prev, ctx) : state;
}

/** Everything the stepper rail needs to paint one stage. */
export type StageStatus<Id extends string = string> = {
  id: Id;
  title: string;
  hint?: string;
  /** 0-based position on the path (the rail shows index + 1 unless `mark` says otherwise). */
  index: number;
  active: boolean;
  enabled: boolean;
  /** ✓ — the stage's work is done and nothing is wrong with it (`mark === 'done'`). */
  done: boolean;
  /** What the rail paints: ✓, a warning, a failure, or the plain step number. */
  mark: StageMark;
  /** The state in words, e.g. "Grant: done" / "Grant: nothing granted yet" — the
   *  tooltip and accessible label, so the state never rides on colour alone. */
  label: string;
  /** The same state for a translated UI (i18n wave 4): the stage's own text (a problem / pending line the tab
   *  wrote) or which of the two fixed words ("done" / "not done yet") applies — the rail renders it in the
   *  reader's language from `common.stage.*`. `label` stays the English. */
  state: { kind: 'text'; text: string } | { kind: 'done' } | { kind: 'notDone' };
};

/** The full rail, resolved against the artifact's current state (`ctx`) and the position. */
export function stageStatuses<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  state: StageState<Id>,
  ctx: Ctx,
): StageStatus<Id>[] {
  return stages.map((s, index) => {
    const problem = s.problem?.(ctx) ?? null;
    const done = !problem && (s.completed?.(ctx) ?? false);
    const mark: StageMark = problem ? problem.tone : done ? 'done' : 'todo';
    const pending = problem || done ? '' : (s.pending?.(ctx) || '');
    const words = problem ? problem.label : done ? 'done' : (pending || 'not done yet');
    const stateWords: StageStatus<Id>['state'] = problem
      ? { kind: 'text', text: problem.label }
      : done ? { kind: 'done' } : pending ? { kind: 'text', text: pending } : { kind: 'notDone' };
    return {
      id: s.id,
      title: s.title,
      hint: s.hint,
      index,
      active: state.current === s.id,
      enabled: canEnter(stages, s.id, ctx),
      done,
      mark,
      label: `${s.title}: ${words}`,
      state: stateWords,
    };
  });
}
