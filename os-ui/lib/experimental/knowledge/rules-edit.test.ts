/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, serializeWorkflow } from './schema.ts';
import { addWorkflowRule, setWorkflowRuleHard, removeWorkflowRule } from './rules-edit.ts';

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
`;

const wf = () => parseWorkflow(BASE);

test('addWorkflowRule adds a soft rule by default at workflow scope', () => {
  const w = addWorkflowRule(wf(), { text: 'Quality over speed' });
  assert.equal(w.rules.length, 1);
  assert.equal(w.rules[0].scope, 'workflow');
  assert.equal(w.rules[0].hard, false);
});

test('addWorkflowRule does not mutate input', () => {
  const o = wf();
  addWorkflowRule(o, { text: 'x' });
  assert.equal(o.rules.length, 0);
});

test('setWorkflowRuleHard toggles hard', () => {
  let w = addWorkflowRule(wf(), { text: 'r' });
  const id = w.rules[0].id;
  w = setWorkflowRuleHard(w, id, true);
  assert.equal(w.rules[0].hard, true);
});

test('removeWorkflowRule removes by id', () => {
  let w = addWorkflowRule(wf(), { text: 'r' });
  const id = w.rules[0].id;
  w = removeWorkflowRule(w, id);
  assert.equal(w.rules.length, 0);
});

test('workflow rules survive serialize → parse', () => {
  let w = addWorkflowRule(wf(), { text: 'Hard one', hard: true });
  w = addWorkflowRule(w, { text: 'Soft one' });
  const again = parseWorkflow(serializeWorkflow(w));
  assert.equal(again.rules.length, 2);
  assert.equal(again.rules.find((r) => r.text === 'Hard one')?.hard, true);
});

test('setWorkflowRuleHard throws on unknown id', () => {
  assert.throws(() => setWorkflowRuleHard(wf(), 'nope', true), /not found/);
});
