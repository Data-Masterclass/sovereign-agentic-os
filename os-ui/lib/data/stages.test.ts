/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance, canEnter, initialStageState, isDone, isSatisfied, markDone, stageStatuses,
} from '@/lib/core/stages';
import { DATA_STAGES, type DataCtx } from './stages.ts';

/**
 * The Data guided path (Define · Ingest · Refine · Publish · Use) run through the shared
 * stage model — asserting the GATES reflect REAL dataset state (the layer dots + tier):
 * later stages stay unreachable until the earlier layer exists, and no stage shows a ✓ on
 * first open even when the dataset is already fully materialized.
 */
const ctx = (over: Partial<DataCtx> = {}): DataCtx => ({
  named: false, bronzeBuilt: false, refined: false, materialized: false, ...over,
});

test('gates reflect real dataset state — nothing past Define is reachable when empty', () => {
  const c = ctx();
  assert.equal(canEnter(DATA_STAGES, 'define', c), true);
  assert.equal(canEnter(DATA_STAGES, 'ingest', c), false); // needs a name
  assert.equal(canEnter(DATA_STAGES, 'refine', c), false);
  assert.equal(canEnter(DATA_STAGES, 'publish', c), false);
  assert.equal(canEnter(DATA_STAGES, 'use', c), false);
});

test('Ingest unlocks on a name; Refine only once Bronze is built', () => {
  assert.equal(canEnter(DATA_STAGES, 'ingest', ctx({ named: true })), true);
  assert.equal(canEnter(DATA_STAGES, 'refine', ctx({ named: true })), false);
  assert.equal(canEnter(DATA_STAGES, 'refine', ctx({ named: true, bronzeBuilt: true })), true);
});

test('Publish gates on a refined layer; Use gates on a materialized layer', () => {
  const bronzeOnly = ctx({ named: true, bronzeBuilt: true, materialized: true });
  assert.equal(canEnter(DATA_STAGES, 'publish', bronzeOnly), false); // Bronze isn't refined
  assert.equal(canEnter(DATA_STAGES, 'use', bronzeOnly), true);      // but it is materialized
  const refined = ctx({ named: true, bronzeBuilt: true, refined: true, materialized: true });
  assert.equal(canEnter(DATA_STAGES, 'publish', refined), true);
  // Nothing materialized → Use locks (a check clears on later invalidation).
  assert.equal(canEnter(DATA_STAGES, 'use', ctx({ named: true, bronzeBuilt: true, materialized: false })), false);
});

test('completed() is the LIVE condition per stage', () => {
  assert.equal(isSatisfied(DATA_STAGES, 'define', ctx({ named: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'ingest', ctx({ bronzeBuilt: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'refine', ctx({ refined: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'publish', ctx({ refined: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'use', ctx({ materialized: true })), true);
});

test('opens on Define with NO pre-marked checks even when the dataset already satisfies stages', () => {
  const fully = ctx({ named: true, bronzeBuilt: true, refined: true, materialized: true });
  const s = initialStageState(DATA_STAGES);
  assert.equal(s.current, 'define');
  for (const st of stageStatuses(DATA_STAGES, s, fully)) assert.equal(st.done, false);
});

test('a ✓ shows only after the user worked the stage this session AND it still holds', () => {
  const refined = ctx({ named: true, bronzeBuilt: true, refined: true, materialized: true });
  let s = initialStageState(DATA_STAGES);           // define
  s = advance(DATA_STAGES, s, refined);             // → ingest, define recorded
  s = advance(DATA_STAGES, s, refined);             // → refine, ingest recorded
  assert.equal(isDone(DATA_STAGES, s, 'define', refined), true);
  assert.equal(isDone(DATA_STAGES, s, 'ingest', refined), true);
  assert.equal(isDone(DATA_STAGES, s, 'refine', refined), false); // worked, but not recorded yet
  s = advance(DATA_STAGES, s, refined);             // → publish, refine recorded
  assert.equal(isDone(DATA_STAGES, s, 'refine', refined), true);
  // Drop the refined layer → refine's recorded ✓ clears because its condition no longer holds.
  const bronzeOnly = ctx({ named: true, bronzeBuilt: true });
  assert.equal(isDone(DATA_STAGES, s, 'refine', bronzeOnly), false);
});

test('markDone records an in-stage settle (Ingest after a Bronze build)', () => {
  const bronze = ctx({ named: true, bronzeBuilt: true, materialized: true });
  let s = initialStageState(DATA_STAGES);
  s = markDone(s, 'ingest');
  assert.equal(isDone(DATA_STAGES, s, 'ingest', bronze), true);
  // Bronze rebuilt away → the ✓ clears.
  assert.equal(isDone(DATA_STAGES, s, 'ingest', ctx({ named: true })), false);
});
