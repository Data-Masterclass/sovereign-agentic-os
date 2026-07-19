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
 * The Data guided path (Ingest · Define · Harmonize · Validate · Publish — 5 stages) run
 * through the shared stage model — asserting the GATES reflect REAL dataset state (the
 * layer dots + tier): later stages stay unreachable until the earlier layer exists, and no
 * stage shows a ✓ on first open even when the dataset is already fully materialized.
 */
const ctx = (over: Partial<DataCtx> = {}): DataCtx => ({
  named: false, bronzeBuilt: false, silverBuilt: false, goldBuilt: false,
  refined: false, materialized: false, ...over,
});

test('5 stages total, in medallion order', () => {
  const ids = DATA_STAGES.map((s) => s.id);
  assert.deepEqual(ids, ['ingest', 'define', 'harmonize', 'validate', 'publish']);
});

test('gates reflect real dataset state — nothing past Ingest is reachable when empty', () => {
  const c = ctx();
  assert.equal(canEnter(DATA_STAGES, 'ingest', c), true);    // always reachable
  assert.equal(canEnter(DATA_STAGES, 'define', c), false);   // needs bronzeBuilt
  assert.equal(canEnter(DATA_STAGES, 'harmonize', c), false);
  assert.equal(canEnter(DATA_STAGES, 'validate', c), false);
  assert.equal(canEnter(DATA_STAGES, 'publish', c), false);
});

test('Define unlocks on Bronze; Harmonize only once Silver is built', () => {
  assert.equal(canEnter(DATA_STAGES, 'define', ctx({ bronzeBuilt: true })), true);
  assert.equal(canEnter(DATA_STAGES, 'harmonize', ctx({ bronzeBuilt: true })), false);
  assert.equal(canEnter(DATA_STAGES, 'harmonize', ctx({ bronzeBuilt: true, silverBuilt: true })), true);
});

test('Validate gates on materialized; Publish gates on refined (Silver or Gold)', () => {
  const bronzeOnly = ctx({ bronzeBuilt: true, materialized: true });
  assert.equal(canEnter(DATA_STAGES, 'validate', bronzeOnly), true);   // materialized
  assert.equal(canEnter(DATA_STAGES, 'publish', bronzeOnly), false);   // not refined

  const refined = ctx({ bronzeBuilt: true, silverBuilt: true, refined: true, materialized: true });
  assert.equal(canEnter(DATA_STAGES, 'publish', refined), true);

  // Nothing materialized → Validate locks.
  assert.equal(canEnter(DATA_STAGES, 'validate', ctx({ bronzeBuilt: true })), false);
});

test('completed() is the LIVE condition per stage', () => {
  assert.equal(isSatisfied(DATA_STAGES, 'ingest', ctx({ bronzeBuilt: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'define', ctx({ silverBuilt: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'harmonize', ctx({ goldBuilt: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'validate', ctx({ materialized: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'publish', ctx({ refined: true })), true);
  // Negative — conditions not met.
  assert.equal(isSatisfied(DATA_STAGES, 'ingest', ctx()), false);
  assert.equal(isSatisfied(DATA_STAGES, 'define', ctx({ bronzeBuilt: true })), false); // silver not built
  assert.equal(isSatisfied(DATA_STAGES, 'harmonize', ctx({ silverBuilt: true })), false); // gold not built
});

test('opens on Ingest with NO pre-marked checks even when the dataset already satisfies stages', () => {
  const fully = ctx({ named: true, bronzeBuilt: true, silverBuilt: true, goldBuilt: true, refined: true, materialized: true });
  const s = initialStageState(DATA_STAGES);
  assert.equal(s.current, 'ingest');
  for (const st of stageStatuses(DATA_STAGES, s, fully)) assert.equal(st.done, false);
});

test('a ✓ shows only after the user worked the stage this session AND it still holds', () => {
  const full = ctx({ named: true, bronzeBuilt: true, silverBuilt: true, goldBuilt: true, refined: true, materialized: true });
  let s = initialStageState(DATA_STAGES);   // ingest
  s = advance(DATA_STAGES, s, full);        // → define, ingest recorded (bronzeBuilt ✓)
  assert.equal(isDone(DATA_STAGES, s, 'ingest', full), true);
  assert.equal(isDone(DATA_STAGES, s, 'define', full), false); // not yet

  s = advance(DATA_STAGES, s, full);        // → harmonize, define recorded (silverBuilt ✓)
  assert.equal(isDone(DATA_STAGES, s, 'define', full), true);

  s = advance(DATA_STAGES, s, full);        // → validate, harmonize recorded (goldBuilt ✓)
  assert.equal(isDone(DATA_STAGES, s, 'harmonize', full), true);

  // Drop gold → harmonize's recorded ✓ clears because its condition no longer holds.
  const noGold = ctx({ bronzeBuilt: true, silverBuilt: true, refined: true, materialized: true });
  assert.equal(isDone(DATA_STAGES, s, 'harmonize', noGold), false);
});

test('markDone records an in-stage settle (Ingest after a Bronze build)', () => {
  const bronze = ctx({ named: true, bronzeBuilt: true, materialized: true });
  let s = initialStageState(DATA_STAGES);
  s = markDone(s, 'ingest');
  assert.equal(isDone(DATA_STAGES, s, 'ingest', bronze), true);
  // Bronze rebuilt away → the ✓ clears.
  assert.equal(isDone(DATA_STAGES, s, 'ingest', ctx({ named: true })), false);
});

test('Publish is the last stage (index 4) — only reachable when Silver or Gold exists', () => {
  const lastIndex = DATA_STAGES.findIndex((s) => s.id === 'publish');
  assert.equal(lastIndex, 4, 'publish must be the final stage (index 4 of 5)');
  assert.equal(DATA_STAGES.length, 5, 'exactly 5 stages');
  assert.equal(canEnter(DATA_STAGES, 'publish', ctx({ refined: false })), false);
  assert.equal(canEnter(DATA_STAGES, 'publish', ctx({ refined: true })), true);
});

test('Validate is the Lineage home — stage id "validate" exists and gates on materialized', () => {
  const validateDef = DATA_STAGES.find((s) => s.id === 'validate');
  assert.ok(validateDef, 'validate stage must exist');
  assert.equal(canEnter(DATA_STAGES, 'validate', ctx({ materialized: true })), true);
  assert.equal(canEnter(DATA_STAGES, 'validate', ctx({ materialized: false })), false);
});
