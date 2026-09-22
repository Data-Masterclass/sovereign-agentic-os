/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The ONE honest pipeline-status derivation shared by Test and Publish. These
 * tests pin the correctness+transparency bug: a live/serving app must show ALL
 * upstream stages complete (never "did not complete") in BOTH surfaces, a real
 * failure must surface the SAME marked stage + message in both, and a fast/cached
 * successful build must read ok — success earned, not lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePipelineView,
  isServingLive,
  PIPELINE_MSG,
  type DeployFacts,
} from './pipeline-view.ts';

const stageStates = (v: ReturnType<typeof derivePipelineView>) =>
  Object.fromEntries(v.steps.map((s) => [s.key, s.state]));

// The Northpeak reproduction: the app is live and serving (releases shipped),
// yet the raw `actions` stage reads not-ok (a post-live edit / fast-cached build
// left the head-sha CI status stale). Before the fix, Test marked "Build image
// (CI)" incomplete while Publish showed green. Now both agree: all complete.
test('live serving app ⇒ ALL upstream stages complete + "complete" message', () => {
  const live: DeployFacts = { state: 'live', releases: 2 };
  // actions is 'pending' AND harbor 'stalled' — genuinely stale per-stage status.
  const raw = { forgejo: 'ok', actions: 'pending', harbor: 'stalled', argocd: 'ok', live: 'ok' };
  const v = derivePipelineView(raw, live);
  assert.deepEqual(stageStates(v), {
    forgejo: 'done',
    actions: 'done',
    harbor: 'done',
    argocd: 'done',
    live: 'done',
  });
  assert.equal(v.done, true);
  assert.equal(v.ok, true);
  assert.equal(v.commentary, PIPELINE_MSG.complete);
});

// The SAME derivation feeds Publish, so Test and Publish read identical steps and
// commentary from the same input — they cannot disagree.
test('Test and Publish read the IDENTICAL derivation (one source of truth)', () => {
  const facts: DeployFacts = { state: 'live', releases: 1 };
  const raw = { forgejo: 'ok', actions: 'pending', harbor: 'disabled', argocd: 'ok', live: 'ok' };
  const forTest = derivePipelineView(raw, facts);
  const forPublish = derivePipelineView(raw, facts);
  assert.deepEqual(forTest, forPublish);
});

// A genuinely FAILED, non-live pipeline: the failing stage is marked in BOTH
// surfaces with the SAME message naming that stage — Publish must not hide it.
test('failed non-live pipeline ⇒ the failed stage marked + named in both surfaces', () => {
  const notLive: DeployFacts = { state: 'building', releases: 0 };
  const raw = { forgejo: 'ok', actions: 'failing', harbor: 'pending', argocd: 'pending', live: 'pending' };
  const v = derivePipelineView(raw, notLive);
  assert.equal(stageStates(v).actions, 'fail');
  assert.equal(stageStates(v).forgejo, 'done');
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  // The message names the marked stage ("Build image (CI)").
  assert.equal(v.commentary, `${PIPELINE_MSG.incompletePrefix}: Build image (CI).`);
});

// (d) The trap: a LIVE app whose LATEST build FAILED must NOT force-green the CI
// stage — it is serving an EARLIER release, and the failure must be loud in both
// surfaces. (Kiekert reproduction: live, releases shipped, but actions='failing'.)
test('live app whose LATEST build FAILED ⇒ CI marked fail + honest "live on earlier release" message', () => {
  const live: DeployFacts = { state: 'live', releases: 2 };
  const raw = { forgejo: 'ok', actions: 'failing', harbor: 'ok', argocd: 'ok', live: 'ok' };
  const v = derivePipelineView(raw, live);
  assert.equal(stageStates(v).actions, 'fail', 'a genuinely failing CI is never force-greened, even when live');
  assert.equal(v.ok, false);
  assert.equal(v.commentary, `${PIPELINE_MSG.staleLivePrefix}: Build image (CI).`);
  // A merely pending/stalled stage on the SAME live app stays benign (force-greened).
  const benign = derivePipelineView({ ...raw, actions: 'ok', harbor: 'stalled' }, live);
  assert.equal(stageStates(benign).harbor, 'done');
  assert.equal(benign.ok, true);
});

// A cached/fast SUCCESSFUL build: the CI stage earned 'ok' — it must read done,
// not failed, even though it built quickly. (Success earned, never lost.)
test('cached/fast successful build ⇒ actions ok (not failed)', () => {
  const live: DeployFacts = { state: 'live', releases: 1 };
  const raw = { forgejo: 'ok', actions: 'ok', harbor: 'ok', argocd: 'ok', live: 'ok' };
  const v = derivePipelineView(raw, live);
  assert.equal(stageStates(v).actions, 'done');
  assert.equal(v.ok, true);
  assert.equal(v.commentary, PIPELINE_MSG.complete);

  // And even without the live-shortcut, a raw 'ok' actions stage is 'done' on its
  // own merit — a fast build is not a failed build.
  const building: DeployFacts = { state: 'building', releases: 0 };
  const v2 = derivePipelineView({ ...raw, live: 'pending' }, building);
  assert.equal(stageStates(v2).actions, 'done');
});

// In-flight (not live, nothing failed, stages still pending) reads "building…".
test('in-flight pipeline ⇒ first pending stage active, building message', () => {
  const building: DeployFacts = { state: 'building', releases: 0 };
  const raw = { forgejo: 'ok', actions: 'pending', harbor: 'pending', argocd: 'pending', live: 'pending' };
  const v = derivePipelineView(raw, building);
  assert.equal(stageStates(v).actions, 'active'); // first incomplete
  assert.equal(stageStates(v).harbor, 'pending');
  assert.equal(v.done, false);
  assert.equal(v.active, true);
  assert.equal(v.commentary, PIPELINE_MSG.building);
});

// isServingLive requires BOTH live state AND a shipped release — an app marked
// live with zero releases is not yet provably built/deployed, so no shortcut.
test('isServingLive requires live state AND a shipped release', () => {
  assert.equal(isServingLive({ state: 'live', releases: 1 }), true);
  assert.equal(isServingLive({ state: 'live', releases: 0 }), false);
  assert.equal(isServingLive({ state: 'review', releases: 3 }), false);
});
