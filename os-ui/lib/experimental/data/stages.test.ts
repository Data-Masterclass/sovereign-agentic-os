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
 * through the shared stage model. Stages are VOLUNTARILY SKIPPABLE — every stage is always
 * reachable (no `enabled` gate), so a user can jump straight from Bronze to Publish. What
 * stays honest is the ✓: `completed()` is the live condition and no stage shows a ✓ on
 * first open (or when skipped) even when the dataset is already fully materialized.
 */
const ctx = (over: Partial<DataCtx> = {}): DataCtx => ({
  named: false, bronzeBuilt: false, silverBuilt: false, goldBuilt: false,
  refined: false, materialized: false, ...over,
});

test('5 stages total, in medallion order', () => {
  const ids = DATA_STAGES.map((s) => s.id);
  assert.deepEqual(ids, ['ingest', 'define', 'harmonize', 'validate', 'publish']);
});

test('every stage is voluntarily reachable — even on a brand-new, empty dataset', () => {
  const c = ctx();
  for (const id of ['ingest', 'define', 'harmonize', 'validate', 'publish'] as const) {
    assert.equal(canEnter(DATA_STAGES, id, c), true, `${id} must be reachable (skippable stages)`);
  }
});

test('no stage declares an enabled gate — navigation is never blocked', () => {
  for (const s of DATA_STAGES) {
    assert.equal(s.enabled, undefined, `${s.id} must not gate entry (voluntary skipping)`);
  }
});

test('a user can jump Bronze → Publish directly (skip Silver + Gold)', () => {
  const bronzeOnly = ctx({ bronzeBuilt: true, materialized: true });
  assert.equal(canEnter(DATA_STAGES, 'publish', bronzeOnly), true);
  assert.equal(canEnter(DATA_STAGES, 'validate', bronzeOnly), true);
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

test('Publish is the last stage (index 4) — reachable regardless of refinement', () => {
  const lastIndex = DATA_STAGES.findIndex((s) => s.id === 'publish');
  assert.equal(lastIndex, 4, 'publish must be the final stage (index 4 of 5)');
  assert.equal(DATA_STAGES.length, 5, 'exactly 5 stages');
  assert.equal(canEnter(DATA_STAGES, 'publish', ctx({ refined: false })), true);
  assert.equal(canEnter(DATA_STAGES, 'publish', ctx({ refined: true })), true);
  // …but its ✓ is still earned only when a refined layer actually exists.
  assert.equal(isSatisfied(DATA_STAGES, 'publish', ctx({ refined: false })), false);
  assert.equal(isSatisfied(DATA_STAGES, 'publish', ctx({ refined: true })), true);
});

test('Validate is the Lineage home — exists, reachable, ✓ earned on materialized', () => {
  const validateDef = DATA_STAGES.find((s) => s.id === 'validate');
  assert.ok(validateDef, 'validate stage must exist');
  assert.equal(canEnter(DATA_STAGES, 'validate', ctx({ materialized: false })), true); // reachable
  assert.equal(isSatisfied(DATA_STAGES, 'validate', ctx({ materialized: true })), true);
  assert.equal(isSatisfied(DATA_STAGES, 'validate', ctx({ materialized: false })), false);
});
