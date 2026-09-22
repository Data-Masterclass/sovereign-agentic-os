/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * build-affordance.test — locks the "Build stage is never an empty dead-end" contract for a
 * DECLARATIVE app. The regression: a spec app authored from epics + granted context landed on
 * Build with a stale/partial autosaved default `draftSpec`, so it neither auto-generated (a
 * draft existed) nor showed the point-me-somewhere empty-state (material was present) — and the
 * manual generate button was developer-only. This test pins that the exact "has stories + has
 * data + default draft + saved work" state resolves to a WORKING affordance ('offer-generate'),
 * plus every neighbouring case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStageAffordance, shouldAutoGenerate, type BuildAffordanceInput } from './build-affordance.ts';

/** A fully-material, fresh-mount base — override per case. */
function base(): BuildAffordanceInput {
  return { hasStories: true, hasData: true, atDefault: true, generating: false, autoFired: false, hasSavedWork: false };
}

test('THE REGRESSION: material present + stale default draftSpec already saved → offer-generate, NOT a dead-end', () => {
  // A failed/aborted first generate autosaved the DEFAULT starter as draftSpec. On the next mount
  // the draft round-trips to the default shape (atDefault stays true) but hasSavedWork is true, so
  // auto-generate is (correctly) skipped. The old code then rendered NOTHING. We now OFFER generate.
  const a = buildStageAffordance({ ...base(), atDefault: true, hasSavedWork: true, autoFired: false });
  assert.equal(a, 'offer-generate');
  // And it is offered in BOTH modes: the caller must not hide it behind the developer surface.
});

test('fresh app with material + no saved work → auto-generate exactly once', () => {
  const first = base();
  assert.equal(buildStageAffordance(first), 'auto-generate');
  assert.equal(shouldAutoGenerate(first), true);
  // Once the one-shot has fired this mount, a re-eval must NOT auto-fire again — it offers instead.
  const afterFire = { ...first, autoFired: true };
  assert.equal(shouldAutoGenerate(afterFire), false);
  assert.equal(buildStageAffordance(afterFire), 'offer-generate');
});

test('never auto-generate over saved work', () => {
  assert.equal(shouldAutoGenerate({ ...base(), hasSavedWork: true }), false);
});

test('no stories → point to Design (Choose Context would be premature)', () => {
  assert.equal(buildStageAffordance({ ...base(), hasStories: false }), 'need-stories');
  assert.equal(buildStageAffordance({ ...base(), hasStories: false, hasData: false }), 'need-stories');
});

test('stories but no granted data → point to Choose Context', () => {
  assert.equal(buildStageAffordance({ ...base(), hasData: false }), 'need-data');
});

test('a real, non-default app is being edited → no CTA', () => {
  assert.equal(buildStageAffordance({ ...base(), atDefault: false }), 'editing');
  // Even with material and saved work, a composed app just edits — never regenerate-nags.
  assert.equal(buildStageAffordance({ ...base(), atDefault: false, hasSavedWork: true }), 'editing');
});

test('while generating, the generate surface owns the screen', () => {
  assert.equal(buildStageAffordance({ ...base(), generating: true, hasSavedWork: true }), 'auto-generate');
});

test('shouldAutoGenerate ignores the transient generating flag', () => {
  // shouldAutoGenerate answers "should the one-shot fire?" — independent of an in-flight spinner.
  assert.equal(shouldAutoGenerate({ ...base(), generating: true }), true);
});
