/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance, canEnter, initialStageState, isDone, isSatisfied, markDone, stageStatuses,
} from '@/lib/core/stages';
import { DASH_STAGES, type DashCtx } from './stages.ts';

/**
 * The Dashboards guided path (Define · Design · Build · View · Govern) run through the
 * shared stage model — asserting the GATES reflect real dashboard state: later stages
 * stay unreachable until the earlier work exists, and no stage shows a ✓ on first open.
 */
const ctx = (over: Partial<DashCtx> = {}): DashCtx => ({
  defined: false, hasCharts: false, builtOk: false, viewed: false, persisted: false, ...over,
});

test('gates reflect real dashboard state — nothing past Define is reachable when empty', () => {
  const c = ctx();
  assert.equal(canEnter(DASH_STAGES, 'define', c), true);
  assert.equal(canEnter(DASH_STAGES, 'design', c), false); // needs a definition
  assert.equal(canEnter(DASH_STAGES, 'build', c), false);
  assert.equal(canEnter(DASH_STAGES, 'view', c), false);
  assert.equal(canEnter(DASH_STAGES, 'govern', c), false);
});

test('Design unlocks on a definition; Build only once charts exist', () => {
  assert.equal(canEnter(DASH_STAGES, 'design', ctx({ defined: true })), true);
  assert.equal(canEnter(DASH_STAGES, 'build', ctx({ defined: true })), false);
  assert.equal(canEnter(DASH_STAGES, 'build', ctx({ defined: true, hasCharts: true })), true);
});

test('View and Govern gate on a successful build (Govern also needs persistence)', () => {
  const built = ctx({ defined: true, hasCharts: true, builtOk: true });
  assert.equal(canEnter(DASH_STAGES, 'view', built), true);
  assert.equal(canEnter(DASH_STAGES, 'govern', built), false); // built but not persisted
  assert.equal(canEnter(DASH_STAGES, 'govern', ctx({ ...built, persisted: true })), true);
  // Build fails → View/Govern lock back up (a check clears on later invalidation).
  assert.equal(canEnter(DASH_STAGES, 'view', ctx({ defined: true, hasCharts: true, builtOk: false })), false);
});

test('completed() is the LIVE condition per stage', () => {
  assert.equal(isSatisfied(DASH_STAGES, 'define', ctx({ defined: true })), true);
  assert.equal(isSatisfied(DASH_STAGES, 'design', ctx({ hasCharts: true })), true);
  assert.equal(isSatisfied(DASH_STAGES, 'build', ctx({ builtOk: true })), true);
  assert.equal(isSatisfied(DASH_STAGES, 'view', ctx({ viewed: true })), true);
  assert.equal(isSatisfied(DASH_STAGES, 'govern', ctx({ persisted: true })), true);
});

test('opens on Define with NO pre-marked checks even when state already satisfies stages', () => {
  const fully = ctx({ defined: true, hasCharts: true, builtOk: true, viewed: true, persisted: true });
  const s = initialStageState(DASH_STAGES);
  assert.equal(s.current, 'define');
  for (const st of stageStatuses(DASH_STAGES, s, fully)) assert.equal(st.done, false);
});

test('a ✓ shows only after the user worked the stage this session AND it still holds', () => {
  const built = ctx({ defined: true, hasCharts: true, builtOk: true });
  let s = initialStageState(DASH_STAGES);            // define
  s = advance(DASH_STAGES, s, built);                // → design, define recorded
  s = advance(DASH_STAGES, s, built);                // → build, design recorded
  assert.equal(isDone(DASH_STAGES, s, 'define', built), true);
  assert.equal(isDone(DASH_STAGES, s, 'design', built), true);
  assert.equal(isDone(DASH_STAGES, s, 'build', built), false); // worked, but not recorded yet
  s = markDone(s, 'build');                           // build settles in-stage
  assert.equal(isDone(DASH_STAGES, s, 'build', built), true);
  // Remove every chart → design's recorded ✓ clears because its condition no longer holds.
  const emptied = ctx({ defined: true });
  assert.equal(isDone(DASH_STAGES, s, 'design', emptied), false);
});
