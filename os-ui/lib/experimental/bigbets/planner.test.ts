/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanResponse, proposePlan } from './planner.ts';

test('parsePlanResponse validates tabs, clamps deps and defaults offsets', () => {
  const raw = JSON.stringify({
    template: 'reduce-churn',
    steps: [
      { tab: 'data', title: 'Churn data', dependsOn: [], offsetDays: 14, rationale: 'mart' },
      { tab: 'ml', title: 'Churn model', dependsOn: [0, 5], offsetDays: 35, rationale: 'predict' }, // dep 5 is out of range → dropped
      { tab: 'not-a-tab', title: 'nope' }, // invalid tab → dropped
      { tab: 'dashboard', title: '', dependsOn: [1] }, // empty title → defaulted; offset defaults
    ],
  });
  const plan = parsePlanResponse('Reduce churn', raw);
  assert.equal(plan.template, 'reduce-churn');
  assert.deepEqual(plan.steps.map((s) => s.tab), ['data', 'ml', 'dashboard']);
  assert.deepEqual(plan.steps[1].dependsOn, [0]); // out-of-range dep clamped away
  assert.ok(plan.steps[2].title.length > 0); // empty title defaulted
  assert.ok(plan.steps.every((s) => s.offsetDays > 0));
});

test('parsePlanResponse throws when the model returns no usable step', () => {
  assert.throws(() => parsePlanResponse('goal', '{"steps":[{"tab":"bogus"}]}'), /usable plan/i);
  assert.throws(() => parsePlanResponse('goal', 'no json here'), /usable plan/i);
});

test('proposePlan asks the injected completer and parses its JSON', async () => {
  const complete = async () => JSON.stringify({ template: 't', steps: [{ tab: 'data', title: 'D', dependsOn: [], offsetDays: 10, rationale: 'r' }] });
  const plan = await proposePlan('Grow revenue', { complete });
  assert.equal(plan.goal, 'Grow revenue');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tab, 'data');
});

test('proposePlan requires a goal', async () => {
  await assert.rejects(proposePlan('   ', { complete: async () => '{}' }), /goal is required/i);
});
