/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Software stage model (components/software/stages.ts) — the pure
 * Define · Design · Build · Test · Publish path: its ids, gates and ✓ conditions.
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
  committed: false,
  previewed: false,
  deployed: false,
  live: false,
};

test('stages: the five ids are Define · Design · Build · Test · Publish, in order', () => {
  assert.deepEqual(
    SW_STAGES.map((s) => s.id),
    ['define', 'design', 'build', 'test', 'publish'],
  );
  assert.deepEqual(
    SW_STAGES.map((s) => s.title),
    ['Define', 'Design', 'Build', 'Test', 'Publish'],
  );
});

test('stages: Define is always reachable; Design/Build need a purpose', () => {
  assert.equal(canEnter(SW_STAGES, 'define', base), true);
  assert.equal(canEnter(SW_STAGES, 'design', base), false);
  assert.equal(canEnter(SW_STAGES, 'build', base), false);
  const withPurpose = { ...base, hasPurpose: true };
  assert.equal(canEnter(SW_STAGES, 'design', withPurpose), true);
  assert.equal(canEnter(SW_STAGES, 'build', withPurpose), true);
});

test('stages: Test and Publish need a committed repo', () => {
  const withPurpose = { ...base, hasPurpose: true };
  assert.equal(canEnter(SW_STAGES, 'test', withPurpose), false);
  assert.equal(canEnter(SW_STAGES, 'publish', withPurpose), false);
  const committed = { ...withPurpose, committed: true };
  assert.equal(canEnter(SW_STAGES, 'test', committed), true);
  assert.equal(canEnter(SW_STAGES, 'publish', committed), true);
});

test('stages: Define ✓ = purpose set', () => {
  assert.equal(isSatisfied(SW_STAGES, 'define', base), false);
  assert.equal(isSatisfied(SW_STAGES, 'define', { ...base, hasPurpose: true }), true);
});

test('stages: Design ✓ = every story has a spec (designSpecComplete), not merely a backlog', () => {
  // A backlog with stories but no specs is NOT design-complete.
  assert.equal(isSatisfied(SW_STAGES, 'design', { ...base, hasDesign: true, designSpecComplete: false }), false);
  assert.equal(isSatisfied(SW_STAGES, 'design', { ...base, designSpecComplete: true }), true);
});

test('stages: Build ✓ = committed; Test ✓ = previewed; Publish ✓ = live', () => {
  assert.equal(isSatisfied(SW_STAGES, 'build', { ...base, committed: true }), true);
  assert.equal(isSatisfied(SW_STAGES, 'test', { ...base, previewed: true }), true);
  assert.equal(isSatisfied(SW_STAGES, 'publish', { ...base, live: true }), true);
  // None satisfied on a bare ctx.
  assert.equal(isSatisfied(SW_STAGES, 'build', base), false);
  assert.equal(isSatisfied(SW_STAGES, 'test', base), false);
  assert.equal(isSatisfied(SW_STAGES, 'publish', base), false);
});

test('stages: no legacy ids remain (preview/operate are gone)', () => {
  const ids = SW_STAGES.map((s) => s.id as string);
  assert.equal(ids.includes('preview'), false);
  assert.equal(ids.includes('operate'), false);
});
