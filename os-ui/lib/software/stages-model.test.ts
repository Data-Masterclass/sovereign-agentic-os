/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Software stage model (components/software/stages.ts) — the pure
 * Define App · Design Epics · Choose Context · Build App · Test & Publish path: its
 * ids, gates and ✓ conditions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SW_STAGES, type SwCtx } from '@/components/software/stages';
import { canEnter, isSatisfied } from '@/lib/core/stages';

const base: SwCtx = {
  named: true,
  hasPurpose: false,
  hasDesign: false,
  designSpecComplete: false,
  contextResolved: false,
  committed: false,
  anyStoryBuilt: false,
  previewed: false,
  deployed: false,
  live: false,
  isSpec: false,
};

test('stages: the five ids are define · design · context · build · publish, in order', () => {
  assert.deepEqual(
    SW_STAGES.map((s) => s.id),
    ['define', 'design', 'context', 'build', 'publish'],
  );
  assert.deepEqual(
    SW_STAGES.map((s) => s.title),
    ['Define App', 'Design Epics', 'Choose Context', 'Build App', 'Test & Publish'],
  );
});

test('stages: Define App is always reachable; Design Epics needs a purpose', () => {
  assert.equal(canEnter(SW_STAGES, 'define', base), true);
  assert.equal(canEnter(SW_STAGES, 'design', base), false);
  const withPurpose = { ...base, hasPurpose: true };
  assert.equal(canEnter(SW_STAGES, 'design', withPurpose), true);
});

test('stages: Choose Context is enterable once Design has epics/stories', () => {
  const withPurpose = { ...base, hasPurpose: true };
  // A purpose alone is not enough — Choose Context needs a backlog to resolve context for.
  assert.equal(canEnter(SW_STAGES, 'context', withPurpose), false);
  const withDesign = { ...withPurpose, hasDesign: true };
  assert.equal(canEnter(SW_STAGES, 'context', withDesign), true);
});

test('stages: Build App is gated on Design (a specced story) AND Choose Context (resolved)', () => {
  // Empty design ⇒ can't Build, even with a purpose and resolved context.
  const noDesign = { ...base, hasPurpose: true, hasDesign: false, contextResolved: true };
  assert.equal(canEnter(SW_STAGES, 'build', noDesign), false);
  // Design exists but context is not resolved yet → Build is not reachable.
  const unresolved = { ...base, hasPurpose: true, hasDesign: true, contextResolved: false };
  assert.equal(canEnter(SW_STAGES, 'build', unresolved), false);
  // Both present → Build is reachable.
  const ready = { ...base, hasPurpose: true, hasDesign: true, contextResolved: true };
  assert.equal(canEnter(SW_STAGES, 'build', ready), true);
});

test('stages: a DECLARATIVE (spec) app reaches Build on a specced backlog alone — data is mapped in the composer, so Choose Context is not a hard gate', () => {
  // Coded app with an unresolved data need is blocked (regression guard for the coded path).
  const coded = { ...base, hasPurpose: true, hasDesign: true, contextResolved: false, isSpec: false };
  assert.equal(canEnter(SW_STAGES, 'build', coded), false);
  // Same unresolved state, but a no-code spec app → Build IS reachable (it maps data per-tab).
  const spec = { ...coded, isSpec: true };
  assert.equal(canEnter(SW_STAGES, 'build', spec), true);
  // A spec app still needs a backlog to build against.
  assert.equal(canEnter(SW_STAGES, 'build', { ...base, hasPurpose: true, hasDesign: false, isSpec: true }), false);
});

test('stages: Test & Publish is blocked until ≥1 story is actually built (committed code)', () => {
  const buildable = { ...base, hasPurpose: true, hasDesign: true, contextResolved: true };
  // A committed/scaffolded repo alone is NOT enough — no story has been built yet.
  assert.equal(canEnter(SW_STAGES, 'publish', { ...buildable, committed: true, anyStoryBuilt: false }), false);
  // Once a story is built (real code committed for it) Test & Publish opens.
  assert.equal(canEnter(SW_STAGES, 'publish', { ...buildable, committed: true, anyStoryBuilt: true }), true);
});

test('stages: Define App ✓ = purpose set', () => {
  assert.equal(isSatisfied(SW_STAGES, 'define', base), false);
  assert.equal(isSatisfied(SW_STAGES, 'define', { ...base, hasPurpose: true }), true);
});

test('stages: Design Epics ✓ = every story has a spec (designSpecComplete), not merely a backlog', () => {
  // A backlog with stories but no specs is NOT design-complete.
  assert.equal(isSatisfied(SW_STAGES, 'design', { ...base, hasDesign: true, designSpecComplete: false }), false);
  assert.equal(isSatisfied(SW_STAGES, 'design', { ...base, designSpecComplete: true }), true);
});

test('stages: Choose Context ✓ = context resolved; Build App ✓ = committed; Test & Publish ✓ = live', () => {
  assert.equal(isSatisfied(SW_STAGES, 'context', { ...base, contextResolved: true }), true);
  assert.equal(isSatisfied(SW_STAGES, 'build', { ...base, committed: true }), true);
  assert.equal(isSatisfied(SW_STAGES, 'publish', { ...base, live: true }), true);
  // None satisfied on a bare ctx.
  assert.equal(isSatisfied(SW_STAGES, 'context', base), false);
  assert.equal(isSatisfied(SW_STAGES, 'build', base), false);
  assert.equal(isSatisfied(SW_STAGES, 'publish', base), false);
});

test('stages: no legacy stage ids remain (preview/operate/test are gone from the flow)', () => {
  const ids = SW_STAGES.map((s) => s.id as string);
  assert.equal(ids.includes('preview'), false);
  assert.equal(ids.includes('operate'), false);
  // 'test' is no longer a standalone stage — it merged into 'publish' (Test & Publish).
  assert.equal(ids.includes('test'), false);
});
