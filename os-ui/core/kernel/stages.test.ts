/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance,
  canEnter,
  goTo,
  initialStageState,
  isDone,
  isSatisfied,
  nextStageId,
  prevStageId,
  retreat,
  stageProblem,
  stageStatuses,
  type StageDef,
} from '@core/kernel/stages';

/**
 * A ctx + stage set mirroring the Agents builder contract exactly:
 * Define · Design · Build · Run · Evaluate with the same gates and conditions.
 */
type Ctx = { named: boolean; ready: boolean; builtOk: boolean; buildFailed?: boolean; hasRun: boolean; checksPass: boolean };
type Id = 'define' | 'design' | 'build' | 'run' | 'evaluate';

const STAGES: StageDef<Id, Ctx>[] = [
  { id: 'define', title: 'Define', hint: 'Name and describe the work.', completed: (c) => c.named },
  { id: 'design', title: 'Design', completed: (c) => c.ready },
  {
    id: 'build', title: 'Build', enabled: (c) => c.ready, completed: (c) => c.builtOk,
    problem: (c) => (c.buildFailed ? { tone: 'error', label: 'the last build failed' } : null),
    pending: () => 'not built yet',
  },
  { id: 'run', title: 'Run', enabled: (c) => c.ready, completed: (c) => c.hasRun },
  { id: 'evaluate', title: 'Evaluate', enabled: (c) => c.ready && c.hasRun, completed: (c) => c.checksPass },
];

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  named: false, ready: false, builtOk: false, hasRun: false, checksPass: false, ...over,
});

test('initialStageState: opens on the FIRST stage and holds only the position', () => {
  const s = initialStageState(STAGES);
  assert.deepEqual(s, { current: 'define' });
  assert.throws(() => initialStageState([]), /must not be empty/);
});

test('a satisfied stage shows ✓ on a FRESH state — first open, reload, another viewer', () => {
  // A fully built artifact, opened cold: nothing was clicked, every finished stage is ticked.
  const rich = ctx({ named: true, ready: true, builtOk: true, hasRun: true, checksPass: true });
  const rail = stageStatuses(STAGES, initialStageState(STAGES), rich);
  assert.deepEqual(rail.map((r) => r.done), [true, true, true, true, true]);
  assert.deepEqual(rail.map((r) => r.mark), ['done', 'done', 'done', 'done', 'done']);
  // "Reload" = a new state object over the same saved artifact → the same rail.
  assert.deepEqual(stageStatuses(STAGES, initialStageState(STAGES), rich), rail);
});

test('an UNSATISFIED stage never shows ✓ — not even after being advanced past', () => {
  let s = initialStageState(STAGES);
  // Define → Design with NO name: the move is allowed (Design is ungated) …
  s = advance(STAGES, s, ctx());
  assert.equal(s.current, 'design');
  // … and Define stays un-ticked, because its work is not done.
  assert.equal(isDone(STAGES, 'define', ctx()), false);
  assert.equal(stageStatuses(STAGES, s, ctx())[0].done, false);
  assert.equal(stageStatuses(STAGES, s, ctx())[0].mark, 'todo');
});

test('the ✓ does not depend on HOW the user moved: rail jump, next, or no move at all', () => {
  const c = ctx({ named: true, ready: true });
  const cold = initialStageState(STAGES);
  const jumped = goTo(STAGES, cold, 'build', c);
  const walked = advance(STAGES, advance(STAGES, cold, c), c);
  const marks = (st: typeof cold) => stageStatuses(STAGES, st, c).map((r) => r.mark);
  assert.deepEqual(marks(cold), ['done', 'done', 'todo', 'todo', 'todo']);
  assert.deepEqual(marks(jumped), marks(cold));
  assert.deepEqual(marks(walked), marks(cold));
});

test('canEnter: omitted `enabled` means always reachable; gates read the live ctx; unknown ids never enter', () => {
  assert.equal(canEnter(STAGES, 'define', ctx()), true);
  assert.equal(canEnter(STAGES, 'design', ctx()), true);
  assert.equal(canEnter(STAGES, 'build', ctx()), false);
  assert.equal(canEnter(STAGES, 'build', ctx({ ready: true })), true);
  assert.equal(canEnter(STAGES, 'evaluate', ctx({ ready: true })), false);
  assert.equal(canEnter(STAGES, 'evaluate', ctx({ ready: true, hasRun: true })), true);
  assert.equal(canEnter(STAGES, 'nope' as Id, ctx()), false);
});

test('goTo: jumps only to enterable stages; identical target returns the same state object', () => {
  const s = initialStageState(STAGES);
  assert.equal(goTo(STAGES, s, 'build', ctx()).current, 'define'); // gated → no-op
  assert.equal(goTo(STAGES, s, 'design', ctx()).current, 'design');
  assert.equal(goTo(STAGES, s, 'define', ctx()), s); // already there → same reference
});

test('isDone: follows the work — true when satisfied, and clears on invalidation', () => {
  assert.equal(isDone(STAGES, 'design', ctx({ ready: true })), true);
  // The user deletes every agent → ready flips false → the ✓ clears.
  assert.equal(isDone(STAGES, 'design', ctx({ ready: false })), false);
  // A stage with no `completed` is never done; an unknown id neither.
  assert.equal(isDone([{ id: 'x', title: 'X' }], 'x', {}), false);
  assert.equal(isDone(STAGES, 'nope' as Id, ctx({ named: true })), false);
});

test('a problem outranks ✓ and is spelled out; a plain unfinished stage says what is missing', () => {
  const failed = ctx({ ready: true, builtOk: false, buildFailed: true });
  assert.deepEqual(stageProblem(STAGES, 'build', failed), { tone: 'error', label: 'the last build failed' });
  const build = stageStatuses(STAGES, initialStageState(STAGES), failed)[2];
  assert.equal(build.mark, 'error');
  assert.equal(build.done, false);
  assert.equal(build.label, 'Build: the last build failed');
  // Even if the condition also held, a known problem is never painted green.
  const both = ctx({ ready: true, builtOk: true, buildFailed: true });
  assert.equal(isDone(STAGES, 'build', both), false);
  assert.equal(stageStatuses(STAGES, initialStageState(STAGES), both)[2].mark, 'error');
  // No problem, not done → the stage's own `pending` words, or a generic fallback.
  const rail = stageStatuses(STAGES, initialStageState(STAGES), ctx({ ready: true }));
  assert.equal(rail[2].label, 'Build: not built yet');
  assert.equal(rail[3].label, 'Run: not done yet');
  assert.equal(rail[1].label, 'Design: done');
  assert.equal(stageProblem(STAGES, 'design', ctx()), null);
});

test('advance: moves only when the NEXT stage is enterable, and records nothing', () => {
  let s = initialStageState(STAGES);
  s = advance(STAGES, s, ctx());
  assert.equal(s.current, 'design');
  // Design → Build with no team: Build is gated on ready → hard no-op.
  assert.equal(advance(STAGES, s, ctx()), s);
  s = advance(STAGES, s, ctx({ ready: true }));
  assert.equal(s.current, 'build');
  s = advance(STAGES, s, ctx({ ready: true }));
  assert.equal(s.current, 'run');
  // Run → Evaluate requires a run (the gate).
  assert.equal(advance(STAGES, s, ctx({ ready: true })), s);
  s = advance(STAGES, s, ctx({ ready: true, hasRun: true }));
  assert.deepEqual(s, { current: 'evaluate' });
  // At the end of the path: no-op.
  assert.equal(advance(STAGES, s, ctx({ ready: true, hasRun: true })), s);
});

test('retreat: steps back one stage, no-op at the start', () => {
  let s = initialStageState(STAGES);
  assert.equal(retreat(STAGES, s, ctx()), s);
  s = goTo(STAGES, s, 'design', ctx());
  s = retreat(STAGES, s, ctx());
  assert.equal(s.current, 'define');
});

test('nextStageId / prevStageId: walk the path, null at the edges and for unknown ids', () => {
  assert.equal(nextStageId(STAGES, 'define'), 'design');
  assert.equal(nextStageId(STAGES, 'evaluate'), null);
  assert.equal(prevStageId(STAGES, 'define'), null);
  assert.equal(prevStageId(STAGES, 'run'), 'build');
  assert.equal(nextStageId(STAGES, 'nope' as Id), null);
  assert.equal(prevStageId(STAGES, 'nope' as Id), null);
});

test('stageStatuses: paints the rail — indexes, active flag, gates and ✓s from the live ctx', () => {
  const c = ctx({ named: true, ready: true });
  const s = goTo(STAGES, initialStageState(STAGES), 'design', c);
  const rail = stageStatuses(STAGES, s, c);
  assert.deepEqual(rail.map((r) => r.id), ['define', 'design', 'build', 'run', 'evaluate']);
  assert.deepEqual(rail.map((r) => r.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(rail.map((r) => r.active), [false, true, false, false, false]);
  assert.deepEqual(rail.map((r) => r.enabled), [true, true, true, true, false]);
  assert.deepEqual(rail.map((r) => r.done), [true, true, false, false, false]);
  assert.equal(rail[0].hint, 'Name and describe the work.');
});

test('end to end: an existing artifact opens ticked, and a tick clears when its work is invalidated', () => {
  let c = ctx({ named: true, ready: true, builtOk: true, hasRun: true, checksPass: true });
  const s = initialStageState(STAGES);
  assert.equal(stageStatuses(STAGES, s, c).filter((r) => r.done).length, 5);
  // The build state is invalidated → only the Build ✓ clears.
  c = { ...c, builtOk: false };
  assert.equal(isDone(STAGES, 'build', c), false);
  assert.equal(isDone(STAGES, 'define', c), true);
  assert.equal(isSatisfied(STAGES, 'design', c), true);
});
