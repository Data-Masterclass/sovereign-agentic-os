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
  markDone,
  nextStageId,
  prevStageId,
  retreat,
  stageStatuses,
  type StageDef,
} from './stages.ts';

/**
 * A ctx + stage set mirroring the Agents builder contract exactly:
 * Define · Design · Build · Run · Evaluate with the same gates and conditions.
 */
type Ctx = { named: boolean; ready: boolean; builtOk: boolean; hasRun: boolean; checksPass: boolean };
type Id = 'define' | 'design' | 'build' | 'run' | 'evaluate';

const STAGES: StageDef<Id, Ctx>[] = [
  { id: 'define', title: 'Define', hint: 'Name and describe the work.', completed: (c) => c.named },
  { id: 'design', title: 'Design', completed: (c) => c.ready },
  { id: 'build', title: 'Build', enabled: (c) => c.ready, completed: (c) => c.builtOk },
  { id: 'run', title: 'Run', enabled: (c) => c.ready, completed: (c) => c.hasRun },
  { id: 'evaluate', title: 'Evaluate', enabled: (c) => c.ready && c.hasRun, completed: (c) => c.checksPass },
];

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  named: false, ready: false, builtOk: false, hasRun: false, checksPass: false, ...over,
});

test('initialStageState: opens on the FIRST stage with an empty done-set (no pre-marked checks)', () => {
  const s = initialStageState(STAGES);
  assert.equal(s.current, 'define');
  assert.equal(s.done.size, 0);
  // Even a fully-satisfied persisted artifact shows NO checks on open.
  const rich = ctx({ named: true, ready: true, builtOk: true, hasRun: true, checksPass: true });
  for (const st of stageStatuses(STAGES, s, rich)) assert.equal(st.done, false);
  assert.throws(() => initialStageState([]), /must not be empty/);
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

test('isDone: requires BOTH the session record and the live condition — and clears on invalidation', () => {
  let s = initialStageState(STAGES);
  // Condition met but never worked this session → no ✓.
  assert.equal(isDone(STAGES, s, 'define', ctx({ named: true })), false);
  s = markDone(s, 'design');
  // Recorded AND satisfied → ✓.
  assert.equal(isDone(STAGES, s, 'design', ctx({ ready: true })), true);
  // The user deletes every agent → ready flips false → the ✓ clears.
  assert.equal(isDone(STAGES, s, 'design', ctx({ ready: false })), false);
});

test('markDone: is idempotent and returns the SAME reference when already recorded (setState bail)', () => {
  const s0 = initialStageState(STAGES);
  const s1 = markDone(s0, 'define');
  assert.notEqual(s1, s0);
  assert.equal(markDone(s1, 'define'), s1);
  assert.equal(s0.done.size, 0); // immutability — the original is untouched
});

test('advance: moves only when the NEXT stage is enterable; records the current stage only if satisfied', () => {
  let s = initialStageState(STAGES);
  // Define → Design with NO name: advances (Design is ungated) but records no ✓.
  s = advance(STAGES, s, ctx());
  assert.equal(s.current, 'design');
  assert.equal(s.done.has('define'), false);
  // Design → Build with no team: Build is gated on ready → hard no-op.
  assert.equal(advance(STAGES, s, ctx()), s);
  // With a team: advances AND records Design (its condition is ready).
  s = advance(STAGES, s, ctx({ ready: true }));
  assert.equal(s.current, 'build');
  assert.equal(isDone(STAGES, s, 'design', ctx({ ready: true })), true);
  // Build → Run without a green build: advances, Build stays unmarked.
  s = advance(STAGES, s, ctx({ ready: true }));
  assert.equal(s.current, 'run');
  assert.equal(s.done.has('build'), false);
  // Run → Evaluate requires a run (the gate) and records Run (its condition).
  assert.equal(advance(STAGES, s, ctx({ ready: true })), s);
  s = advance(STAGES, s, ctx({ ready: true, hasRun: true }));
  assert.equal(s.current, 'evaluate');
  assert.equal(s.done.has('run'), true);
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
  let s = initialStageState(STAGES);
  s = markDone(s, 'define');
  s = goTo(STAGES, s, 'design', ctx());
  const c = ctx({ named: true, ready: true });
  const rail = stageStatuses(STAGES, s, c);
  assert.deepEqual(rail.map((r) => r.id), ['define', 'design', 'build', 'run', 'evaluate']);
  assert.deepEqual(rail.map((r) => r.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(rail.map((r) => r.active), [false, true, false, false, false]);
  assert.deepEqual(rail.map((r) => r.enabled), [true, true, true, true, false]);
  assert.deepEqual(rail.map((r) => r.done), [true, false, false, false, false]);
  assert.equal(rail[0].hint, 'Name and describe the work.');
});

test('the Agents session contract end-to-end: no pre-marks, genuine progress, live-state checks', () => {
  // Open an EXISTING, fully-built system: lands on Define, zero checks.
  let c = ctx({ named: true, ready: true, builtOk: true, hasRun: true, checksPass: true });
  let s = initialStageState(STAGES);
  assert.equal(stageStatuses(STAGES, s, c).filter((r) => r.done).length, 0);
  // The user walks Define → Design → Build: both earlier stages earn their ✓.
  s = advance(STAGES, s, c);
  s = advance(STAGES, s, c);
  assert.equal(s.current, 'build');
  assert.equal(isDone(STAGES, s, 'define', c), true);
  assert.equal(isDone(STAGES, s, 'design', c), true);
  // Build settles in-panel → the tab records it via markDone.
  s = markDone(s, 'build');
  assert.equal(isDone(STAGES, s, 'build', c), true);
  // Later the build state is invalidated → the Build ✓ clears, Define/Design keep theirs.
  c = { ...c, builtOk: false };
  assert.equal(isDone(STAGES, s, 'build', c), false);
  assert.equal(isDone(STAGES, s, 'define', c), true);
});
