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
 * The contract (extracted verbatim from the Agents builder):
 *  • Stages form an ordered path. Each stage may gate entry (`enabled(ctx)`) and
 *    declares when its work is genuinely done (`completed(ctx)`).
 *  • A `StageState` always opens on the FIRST stage with an EMPTY done-set — a
 *    freshly opened artifact never shows pre-marked checks, even if its persisted
 *    state happens to satisfy a stage's condition.
 *  • A stage is recorded as done when the user advances past it WITH its condition
 *    met (`advance`), or when its in-stage work settles (`markDone`).
 *  • The ✓ a stage displays = recorded-this-session AND the condition STILL holds
 *    (`isDone`) — so a check clears if the user later invalidates it (e.g. deletes
 *    every agent).
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
  /** Is this stage's underlying condition satisfied right now? Omitted → never. */
  completed?: (ctx: Ctx) => boolean;
};

/** The session-tracked position + progress. Immutable — every transition returns a new value. */
export type StageState<Id extends string = string> = {
  /** The stage currently on screen. */
  current: Id;
  /** Stages the user has actually completed THIS session (starts empty). */
  done: ReadonlySet<Id>;
};

/** Open on the first stage with nothing pre-marked. Throws on an empty stage list. */
export function initialStageState<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
): StageState<Id> {
  const first = stages[0];
  if (!first) throw new Error('initialStageState: stages must not be empty');
  return { current: first.id, done: new Set<Id>() };
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

/** Is the stage's underlying condition satisfied right now (regardless of session progress)? */
export function isSatisfied<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  id: Id,
  ctx: Ctx,
): boolean {
  return stageDefOf(stages, id)?.completed?.(ctx) ?? false;
}

/**
 * Does the stage show a ✓? Only when the user completed it this session AND its
 * condition still holds — never on first open, and it clears on later invalidation.
 */
export function isDone<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  state: StageState<Id>,
  id: Id,
  ctx: Ctx,
): boolean {
  return state.done.has(id) && isSatisfied(stages, id, ctx);
}

/**
 * Record a stage as completed this session (idempotent — returns the SAME state
 * object when already recorded, so React setState bails without a re-render).
 * Display still gates on the live condition via `isDone`.
 */
export function markDone<Id extends string>(state: StageState<Id>, id: Id): StageState<Id> {
  if (state.done.has(id)) return state;
  const done = new Set(state.done);
  done.add(id);
  return { ...state, done };
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
 * Move forward one stage: a no-op unless the NEXT stage is enterable; the current
 * stage is recorded as done only when its condition is actually met — so skipping
 * ahead past unfinished work never fakes a ✓.
 */
export function advance<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  state: StageState<Id>,
  ctx: Ctx,
): StageState<Id> {
  const next = nextStageId(stages, state.current);
  if (!next || !canEnter(stages, next, ctx)) return state;
  const recorded = isSatisfied(stages, state.current, ctx) ? markDone(state, state.current) : state;
  return { ...recorded, current: next };
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
  /** 0-based position on the path (the rail shows index + 1, or ✓ when done). */
  index: number;
  active: boolean;
  enabled: boolean;
  done: boolean;
};

/** The full rail, resolved against the live ctx + session state. */
export function stageStatuses<Id extends string, Ctx>(
  stages: readonly StageDef<Id, Ctx>[],
  state: StageState<Id>,
  ctx: Ctx,
): StageStatus<Id>[] {
  return stages.map((s, index) => ({
    id: s.id,
    title: s.title,
    hint: s.hint,
    index,
    active: state.current === s.id,
    enabled: canEnter(stages, s.id, ctx),
    done: isDone(stages, state, s.id, ctx),
  }));
}
