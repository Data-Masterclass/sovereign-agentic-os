/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  framingForRole,
  targetAnchor,
  stepVisibleForRole,
  walkSteps,
  assertSandboxSafe,
  panelForRole,
} from './engine.ts';
import type { TutorialDef, WalkStep } from './types.ts';

const step = (s: Partial<WalkStep> & { anchor: string }): WalkStep => ({
  title: 't',
  body: 'b',
  ...s,
});

const fixture: TutorialDef = {
  key: 'data',
  route: '/data',
  title: 'Data',
  tagline: 'tagline',
  hook: {
    illustration: 'load',
    title: 'Hook',
    body: 'default body',
    byRole: { builder: { body: 'builder body' } },
  },
  steps: [],
  walkthrough: [
    step({ anchor: 'data.sandbox', sandboxAnchor: 'data.sandbox' }),
    step({ anchor: 'data.load', sandboxAnchor: 'data.load' }),
    step({ anchor: 'data.clean' }), // non-write, no sandbox target → coalesced
    step({ anchor: 'data.publish', governedWrite: true }), // real-only
    step({ anchor: 'data.promote', roles: ['builder'], governedWrite: true }),
  ],
  sandbox: { lane: 'My data', anchor: 'data.sandbox', note: 'note' },
  outro: { title: 'done', body: 'b', next: ['metrics'], doc: 'data-golden-path.md' },
  framing: {
    user: { verb: 'Use', hook: 'use it' },
    creator: { verb: 'Create', hook: 'create it' },
    builder: { verb: 'Review & promote', hook: 'promote it' },
  },
};

test('session role maps to framing role', () => {
  assert.equal(framingForRole('participant'), 'creator');
  assert.equal(framingForRole('builder'), 'builder');
  assert.equal(framingForRole('admin'), 'builder');
  assert.equal(framingForRole(undefined), 'user');
  assert.equal(framingForRole(null), 'user');
});

test('sandbox mode targets the sandbox anchor, real mode the real anchor', () => {
  const s = step({ anchor: 'data.load', sandboxAnchor: 'data.load.sb' });
  assert.equal(targetAnchor(s, 'sandbox'), 'data.load.sb');
  assert.equal(targetAnchor(s, 'real'), 'data.load');
  // falls back to the real anchor when no sandbox target is declared
  assert.equal(targetAnchor(step({ anchor: 'x' }), 'sandbox'), 'x');
});

test('role-restricted steps are hidden from other roles', () => {
  const builderOnly = step({ anchor: 'a', roles: ['builder'] });
  assert.equal(stepVisibleForRole(builderOnly, 'builder'), true);
  assert.equal(stepVisibleForRole(builderOnly, 'creator'), false);
  assert.equal(stepVisibleForRole(step({ anchor: 'a' }), 'user'), true);
});

test('PROOF: sandbox walk-through contains NO governed-write steps', () => {
  const sandbox = walkSteps(fixture, 'sandbox', 'builder');
  assert.ok(sandbox.length > 0);
  assert.ok(
    sandbox.every((s) => !s.governedWrite),
    'a governed write leaked into the sandbox walk-through',
  );
  // and the guard agrees
  assert.doesNotThrow(() => assertSandboxSafe(sandbox));
});

test('assertSandboxSafe throws if a governed write is present', () => {
  assert.throws(() => assertSandboxSafe([step({ anchor: 'x', governedWrite: true })]));
});

test('PROOF: every sandbox step targets the lane, never a governed control', () => {
  const sandbox = walkSteps(fixture, 'sandbox', 'creator');
  // the no-sandbox-target step was coalesced onto the lane anchor
  const clean = sandbox.find((s) => s.anchor === 'data.clean');
  assert.ok(clean);
  assert.equal(clean.sandboxAnchor, fixture.sandbox.anchor);
  // every sandbox step now has a sandbox target → guard passes
  assert.ok(sandbox.every((s) => !!s.sandboxAnchor));
  assert.doesNotThrow(() => assertSandboxSafe(sandbox));
});

test('assertSandboxSafe throws if a non-write step has no sandbox target', () => {
  assert.throws(() => assertSandboxSafe([step({ anchor: 'data.clean' })]));
});

test('real mode keeps governed writes; role filters them by role', () => {
  const creatorReal = walkSteps(fixture, 'real', 'creator');
  const builderReal = walkSteps(fixture, 'real', 'builder');
  // creator does not see the builder-only promote step
  assert.ok(!creatorReal.some((s) => s.anchor === 'data.promote'));
  assert.ok(builderReal.some((s) => s.anchor === 'data.promote'));
  // both see the non-role-restricted governed publish step
  assert.ok(creatorReal.some((s) => s.anchor === 'data.publish'));
});

test('panel captions are role-framed with fallback to default', () => {
  assert.equal(panelForRole(fixture.hook, 'builder').body, 'builder body');
  assert.equal(panelForRole(fixture.hook, 'creator').body, 'default body');
});
