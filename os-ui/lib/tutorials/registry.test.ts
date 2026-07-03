/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTutorial, listTutorials, TUTORIAL_ORDER, isGoldenPathKey } from './registry.ts';
import { assertSandboxSafe, walkSteps } from './engine.ts';
import type { FramingRole } from './types.ts';

const ROLES: FramingRole[] = ['user', 'creator', 'builder'];

// ---- registry completeness ------------------------------------------------

test('all 10 golden paths are in the registry', () => {
  const expected: string[] = [
    'data', 'knowledge', 'connections', 'agents', 'software',
    'science', 'metrics', 'dashboards', 'big-bets', 'marketplace',
  ];
  assert.deepEqual(TUTORIAL_ORDER, expected, 'canonical order must match golden-path docs');
  for (const key of expected) {
    const def = getTutorial(key);
    assert.ok(def, `missing tutorial for key "${key}"`);
    assert.equal(def!.key, key, `tutorial "${key}" declares wrong key "${def!.key}"`);
  }
});

test('listTutorials returns all 10 in canonical order', () => {
  const list = listTutorials();
  assert.equal(list.length, 10);
  list.forEach((def, i) => {
    assert.equal(def.key, TUTORIAL_ORDER[i]);
  });
});

test('isGoldenPathKey accepts valid keys and rejects unknown strings', () => {
  assert.ok(isGoldenPathKey('data'));
  assert.ok(isGoldenPathKey('marketplace'));
  assert.ok(!isGoldenPathKey('governance'));
  assert.ok(!isGoldenPathKey(''));
  assert.ok(!isGoldenPathKey('monitoring'));
});

// ---- every tutorial is structurally valid ---------------------------------

test('every tutorial has a title, tagline, hook, 3-5 steps, walkthrough, sandbox, outro', () => {
  for (const def of listTutorials()) {
    assert.ok(def.title, `"${def.key}" has no title`);
    assert.ok(def.tagline, `"${def.key}" has no tagline`);
    assert.ok(def.hook, `"${def.key}" has no hook panel`);
    assert.ok(def.steps.length >= 3 && def.steps.length <= 5,
      `"${def.key}" has ${def.steps.length} steps (expected 3-5)`);
    assert.ok(def.walkthrough.length > 0, `"${def.key}" has no walk-through steps`);
    assert.ok(def.sandbox?.anchor, `"${def.key}" has no sandbox anchor`);
    assert.ok(def.outro?.next.length, `"${def.key}" has no outro.next cross-links`);
  }
});

test('every tutorial declares framing for all three roles', () => {
  for (const def of listTutorials()) {
    for (const role of ROLES) {
      assert.ok(def.framing[role]?.verb, `"${def.key}" missing framing.${role}.verb`);
      assert.ok(def.framing[role]?.hook, `"${def.key}" missing framing.${role}.hook`);
    }
  }
});

// ---- sandbox safety proof -------------------------------------------------

test('PROOF: sandbox walk for every tutorial/role contains no governed writes', () => {
  for (const def of listTutorials()) {
    for (const role of ROLES) {
      const steps = walkSteps(def, 'sandbox', role);
      assert.doesNotThrow(
        () => assertSandboxSafe(steps),
        `sandbox leak in "${def.key}" as ${role}`,
      );
    }
  }
});

test('real walk for every tutorial preserves all role-visible steps', () => {
  for (const def of listTutorials()) {
    // builder sees everything; other roles may see fewer steps
    const builderSteps = walkSteps(def, 'real', 'builder');
    assert.ok(builderSteps.length > 0, `"${def.key}" has no real walk steps for builder`);
    // creator/user never see more than builder
    for (const role of ['user', 'creator'] as FramingRole[]) {
      const steps = walkSteps(def, 'real', role);
      assert.ok(steps.length <= builderSteps.length,
        `"${def.key}" as ${role} has MORE steps than builder — role filter broken`);
    }
  }
});
