/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Phase D — the status-card semantics for a RUNTIME-served app. The image-only
 * stages (Build image / Publish to registry / Deploy) must read as not-applicable
 * (complete + relabelled "(n/a)", NEVER failing) and the commentary must be the one
 * honest runtime line. An image-served app is unaffected (the historic view).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePipelineView, RUNTIME_SERVE_MSG, type DeployFacts } from './pipeline-view.ts';

const byKey = (v: ReturnType<typeof derivePipelineView>) =>
  Object.fromEntries(v.steps.map((s) => [s.key, s]));

test('runtime serveMode ⇒ image stages are not-applicable (done + relabelled), never failing', () => {
  // Even with genuinely red image stages, runtime serving does not run them.
  const raw = { forgejo: 'ok', actions: 'failing', harbor: 'offline', argocd: 'stalled', live: 'pending' };
  const facts: DeployFacts = { state: 'preview', releases: 0, serveMode: 'runtime' };
  const v = derivePipelineView(raw, facts);
  const steps = byKey(v);
  for (const s of ['actions', 'harbor', 'argocd']) {
    assert.equal(steps[s].state, 'done', `${s} is not-applicable in runtime mode`);
    assert.match(steps[s].label, /n\/a/i, `${s} is relabelled as not-applicable`);
  }
  assert.equal(v.ok, true, 'a runtime app is never "failed" by absent image stages');
  assert.equal(v.commentary, RUNTIME_SERVE_MSG);
});

test('runtime serveMode ⇒ scaffold present makes the app live/serving', () => {
  const raw = { forgejo: 'ok', actions: 'pending', harbor: 'pending', argocd: 'pending', live: 'pending' };
  const v = derivePipelineView(raw, { state: 'building', releases: 0, serveMode: 'runtime' });
  const steps = byKey(v);
  assert.equal(steps.forgejo.state, 'done', 'scaffold reflects real ok');
  assert.equal(steps.live.state, 'done', 'live is earned from the tree existing (scaffold ok)');
  assert.equal(v.done, true);
  assert.equal(v.ok, true);
  assert.equal(v.commentary, RUNTIME_SERVE_MSG);
});

test('runtime serveMode ⇒ a failing scaffold still surfaces (no false green)', () => {
  const raw = { forgejo: 'offline', actions: 'ok', harbor: 'ok', argocd: 'ok', live: 'ok' };
  const v = derivePipelineView(raw, { state: 'building', releases: 0, serveMode: 'runtime' });
  const steps = byKey(v);
  assert.equal(steps.forgejo.state, 'fail', 'a real scaffold failure is honest');
  assert.equal(steps.live.state, 'pending', 'live is not claimed when scaffold is not ok');
  assert.equal(v.ok, false);
  assert.match(v.commentary, /needs attention/i);
});

test('image serveMode (default) is the historic view — unchanged by Phase D', () => {
  const raw = { forgejo: 'ok', actions: 'failing', harbor: 'pending', argocd: 'pending', live: 'pending' };
  // No serveMode (legacy) behaves exactly like explicit 'image'.
  const legacy = derivePipelineView(raw, { state: 'building', releases: 0 });
  const image = derivePipelineView(raw, { state: 'building', releases: 0, serveMode: 'image' });
  assert.deepEqual(byKey(legacy).actions.state, 'fail');
  assert.deepEqual(byKey(image).actions.state, 'fail');
  assert.equal(legacy.commentary, image.commentary);
  assert.notEqual(image.commentary, RUNTIME_SERVE_MSG);
});
