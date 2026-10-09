/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/** Tests for the live BUILD stepper derivation (components/software/build-progress.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBuildProgress, type BuildRunSignals } from './build-progress.ts';

const base: BuildRunSignals = {
  running: false, hasPlan: false, activityCount: 0, committed: false, previewed: false, failed: false,
};
const stateOf = (r: ReturnType<typeof deriveBuildProgress>, key: string) => r.steps.find((s) => s.key === key)!.state;

test('build-progress: idle with no progress is inert (all pending, not done)', () => {
  const r = deriveBuildProgress(base);
  assert.equal(r.active, false);
  assert.equal(r.done, false);
  assert.deepEqual(r.steps.map((s) => s.state), ['pending', 'pending', 'pending', 'pending']);
});

test('build-progress: while planning, Plan is active and the run is in flight', () => {
  const r = deriveBuildProgress({ ...base, running: true, hasPlan: true });
  assert.equal(r.active, true);
  assert.equal(stateOf(r, 'plan'), 'active');
  assert.equal(stateOf(r, 'generate'), 'pending');
});

test('build-progress: with activity streaming, Plan is done and Generate is the active frontier', () => {
  const r = deriveBuildProgress({ ...base, running: true, hasPlan: true, activityCount: 3 });
  assert.equal(stateOf(r, 'plan'), 'done');
  assert.equal(stateOf(r, 'generate'), 'active');
  assert.equal(stateOf(r, 'commit'), 'pending'); // not reached until a commit lands
});

test('build-progress: a committed, settled run marks up to Commit done (Preview stays pending)', () => {
  const r = deriveBuildProgress({ ...base, running: false, hasPlan: true, activityCount: 5, committed: true });
  assert.equal(r.done, true);
  assert.equal(r.ok, true);
  assert.equal(r.active, false);
  assert.equal(stateOf(r, 'commit'), 'done');
  assert.equal(stateOf(r, 'preview'), 'pending');
});

test('build-progress: a preview served advances the whole run to Preview done', () => {
  const r = deriveBuildProgress({ ...base, running: false, hasPlan: true, activityCount: 5, committed: true, previewed: true });
  assert.equal(stateOf(r, 'preview'), 'done');
  assert.equal(r.done, true);
});

test('build-progress: a failed run marks the frontier step failed and is not ok', () => {
  const r = deriveBuildProgress({ ...base, running: false, hasPlan: true, activityCount: 2, failed: true });
  assert.equal(r.ok, false);
  assert.equal(r.done, true);
  assert.equal(stateOf(r, 'generate'), 'fail'); // frontier was Generate (activity landed, no commit yet)
});
