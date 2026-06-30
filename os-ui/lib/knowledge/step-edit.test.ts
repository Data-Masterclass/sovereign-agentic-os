/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, serializeWorkflow } from './schema.ts';
import {
  addStep,
  removeStep,
  moveStep,
  updateStep,
  setStepIO,
  addStepLink,
  removeStepLink,
  addStepRule,
  setStepRuleHard,
  removeStepRule,
} from './step-edit.ts';

const BASE = `---
id: wf
title: WF
domain: sales
visibility: Personal
status: draft
version: "1"
---

\`\`\`step
id: one
title: One
actor: Human
\`\`\`

\`\`\`step
id: two
title: Two
actor: Software
\`\`\`
`;

const wf = () => parseWorkflow(BASE);

test('addStep appends with a unique slug id', () => {
  const w = addStep(wf(), { title: 'One', actor: 'Agent' }); // collides with existing "one"
  assert.equal(w.steps.length, 3);
  assert.notEqual(w.steps[2].id, 'one');
  assert.equal(w.steps[2].actor, 'Agent');
});

test('addStep does not mutate the input (immutable)', () => {
  const original = wf();
  addStep(original, { title: 'New' });
  assert.equal(original.steps.length, 2);
});

test('removeStep drops the step and its scoped workflow rules', () => {
  const w0 = wf();
  w0.rules.push({ id: 'wr', text: 'x', hard: true, scope: 'step', step_id: 'two' });
  const w = removeStep(w0, 'two');
  assert.equal(w.steps.length, 1);
  assert.equal(w.rules.length, 0);
});

test('moveStep reorders within bounds, no-op at ends', () => {
  assert.equal(moveStep(wf(), 'two', 1).steps.map((s) => s.id).join(','), 'one,two'); // already last
  assert.equal(moveStep(wf(), 'two', -1).steps.map((s) => s.id).join(','), 'two,one');
});

test('updateStep patches actor + title', () => {
  const w = updateStep(wf(), 'one', { actor: 'Agent', title: 'First' });
  assert.equal(w.steps[0].actor, 'Agent');
  assert.equal(w.steps[0].title, 'First');
});

test('setStepIO replaces inputs/outputs, trimming blanks', () => {
  const w = setStepIO(wf(), 'one', { inputs: ['  A ', '', 'B'], outputs: ['C'] });
  assert.deepEqual(w.steps[0].inputs, ['A', 'B']);
  assert.deepEqual(w.steps[0].outputs, ['C']);
});

test('addStepLink adds, dedupes; removeStepLink removes', () => {
  let w = addStepLink(wf(), 'one', { type: 'data', ref: 'sales.gold.x', label: 'X' });
  w = addStepLink(w, 'one', { type: 'data', ref: 'sales.gold.x' }); // dup
  assert.equal(w.steps[0].links.length, 1);
  w = removeStepLink(w, 'one', { type: 'data', ref: 'sales.gold.x' });
  assert.equal(w.steps[0].links.length, 0);
});

test('addStepRule (soft default) → setStepRuleHard → removeStepRule', () => {
  let w = addStepRule(wf(), 'two', { text: 'Must validate' });
  assert.equal(w.steps[1].rules.length, 1);
  assert.equal(w.steps[1].rules[0].hard, false);
  const rid = w.steps[1].rules[0].id;
  w = setStepRuleHard(w, 'two', rid, true);
  assert.equal(w.steps[1].rules[0].hard, true);
  w = removeStepRule(w, 'two', rid);
  assert.equal(w.steps[1].rules.length, 0);
});

test('edits survive a serialize → parse round-trip', () => {
  let w = addStep(wf(), { title: 'Verify', actor: 'Agent' });
  w = addStepLink(w, w.steps[2].id, { type: 'agent', ref: 'sys_x', label: 'X' });
  w = addStepRule(w, w.steps[2].id, { text: 'Hard', hard: true });
  const again = parseWorkflow(serializeWorkflow(w));
  assert.equal(again.steps.length, 3);
  assert.equal(again.steps[2].actor, 'Agent');
  assert.equal(again.steps[2].links[0].ref, 'sys_x');
  assert.equal(again.steps[2].rules[0].hard, true);
});

test('removeStep on unknown id throws', () => {
  assert.throws(() => removeStep(wf(), 'nope'), /not in this workflow/);
});
