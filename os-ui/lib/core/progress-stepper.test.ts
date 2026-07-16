/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  barPct,
  barFillClasses,
  stepClasses,
  stepDotGlyph,
  type Step,
} from './progress-stepper.ts';

const steps = (states: Step['state'][]): Step[] =>
  states.map((state, i) => ({ key: `s${i}`, label: `Step ${i}`, state }));

test('barPct: never reaches 100 until done, floors while active', () => {
  const s = steps(['done', 'active', 'pending', 'pending']); // 1 of 4 done
  const pct = barPct(s, { active: true, done: false });
  assert.equal(pct, 25);
  // Nothing done yet but in flight → a visible sliver, not 0.
  assert.equal(barPct(steps(['active', 'pending']), { active: true, done: false }), 6);
  // Even "all done" states pre-settle stay capped below 100.
  assert.equal(barPct(steps(['done', 'done']), { active: true, done: false }), 96);
});

test('barPct: settles to exactly 100 when done', () => {
  assert.equal(barPct(steps(['done', 'done', 'fail']), { active: false, done: true }), 100);
  assert.equal(barPct([], { active: false, done: true }), 100);
});

test('barPct: explicit pct overrides the derived value but is still clamped', () => {
  assert.equal(barPct(steps(['pending', 'pending']), { active: true, done: false, pct: 40 }), 40);
  assert.equal(barPct(steps(['pending']), { active: true, done: false, pct: 200 }), 96);
});

test('barFillClasses: shimmer while active, teal on ok-done, red on fail-done', () => {
  assert.equal(barFillClasses({ active: true, done: false, ok: true }), 'animating');
  assert.equal(barFillClasses({ active: false, done: true, ok: true }), 'ok');
  assert.equal(barFillClasses({ active: false, done: true, ok: false }), 'fail');
  assert.equal(barFillClasses({ active: false, done: false, ok: true }), '');
});

test('stepClasses: maps each state to its suffix class', () => {
  assert.equal(stepClasses('active'), 'active');
  assert.equal(stepClasses('done'), 'done');
  assert.equal(stepClasses('fail'), 'fail');
  assert.equal(stepClasses('pending'), '');
});

test('stepDotGlyph: ✓ / ✗ / spin sentinel / 1-based number', () => {
  assert.equal(stepDotGlyph('done', 0), '✓');
  assert.equal(stepDotGlyph('fail', 1), '✗');
  assert.equal(stepDotGlyph('active', 2), 'spin');
  assert.equal(stepDotGlyph('pending', 2), 3);
});
