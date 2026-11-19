/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEnter, initialStageState, isDone, isSatisfied, stageStatuses,
} from '@core/kernel/stages';
import { DATA_STAGES, type DataCtx } from '@tabs/data/lib/stages';

/**
 * The Data guided path (Ingest · Define · Harmonize · Validate · Publish — 5 stages) run
 * through the shared stage model. Stages are VOLUNTARILY SKIPPABLE — every stage is always
 * reachable (no `enabled` gate), so a user can jump straight from Bronze to Publish. What
 * stays honest is the ✓: `completed()` reads the dataset's real layers, so a materialized
 * dataset opens with its built layers ticked and a skipped stage simply stays un-ticked.
 * (This model is not mounted by any screen today — the Data detail retired the staged walk.)
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

test('opens on Ingest; an already-materialized dataset shows its built layers ticked', () => {
  const fully = ctx({ named: true, bronzeBuilt: true, silverBuilt: true, goldBuilt: true, refined: true, materialized: true });
  const s = initialStageState(DATA_STAGES);
  assert.equal(s.current, 'ingest');
  for (const st of stageStatuses(DATA_STAGES, s, fully)) assert.equal(st.done, true, `${st.id} is built`);
  // A brand-new dataset shows none.
  for (const st of stageStatuses(DATA_STAGES, s, ctx({ named: true }))) assert.equal(st.done, false);
});

test('a skipped layer stays un-ticked, and a ✓ clears when its layer is rebuilt away', () => {
  const noSilver = ctx({ named: true, bronzeBuilt: true, goldBuilt: true, refined: true, materialized: true });
  assert.equal(isDone(DATA_STAGES, 'ingest', noSilver), true);
  assert.equal(isDone(DATA_STAGES, 'define', noSilver), false); // Silver was skipped
  assert.equal(isDone(DATA_STAGES, 'harmonize', noSilver), true);
  // Drop gold → the Harmonize ✓ clears because its condition no longer holds.
  assert.equal(isDone(DATA_STAGES, 'harmonize', { ...noSilver, goldBuilt: false }), false);
  // Bronze rebuilt away → the Ingest ✓ clears.
  assert.equal(isDone(DATA_STAGES, 'ingest', ctx({ named: true })), false);
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
