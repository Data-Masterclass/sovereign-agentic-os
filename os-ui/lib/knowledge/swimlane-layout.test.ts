/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from './schema.ts';
import { layoutSwimlanes } from './swimlane-layout.ts';

const WF = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Personal
status: draft
version: "1"
---

\`\`\`step
id: prepare
title: Prepare Documents
actor: Human
actor_name: Loan Officer
inputs: [Application]
outputs: [Package]
\`\`\`

> tacit: Check section 4.

\`\`\`step
id: submit
title: Submit
actor: Software
links:
  - {type: app, ref: "app://bank-portal", label: Bank Portal}
\`\`\`

\`\`\`step
id: verify
title: Verify
actor: Agent
rules:
  - {id: r1, text: Error < 0.1%, hard: true}
\`\`\`
`;

test('one lane per actor type present, in fixed order', () => {
  const w = parseWorkflow(WF);
  const layout = layoutSwimlanes(w);
  assert.deepEqual(layout.lanes.map((l) => l.actor), ['Human', 'Software', 'Agent']);
});

test('each step placed in its actor lane column x', () => {
  const w = parseWorkflow(WF);
  const layout = layoutSwimlanes(w);
  const humanLane = layout.lanes.find((l) => l.actor === 'Human')!;
  const prepare = layout.blocks.find((b) => b.id === 'prepare')!;
  assert.ok(prepare.x >= humanLane.x && prepare.x < humanLane.x + humanLane.width);
});

test('steps ordered top-to-bottom by sequence', () => {
  const w = parseWorkflow(WF);
  const layout = layoutSwimlanes(w);
  const ys = layout.blocks.map((b) => b.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], 'y should increase by seq');
});

test('sequential connectors join consecutive steps', () => {
  const w = parseWorkflow(WF);
  const layout = layoutSwimlanes(w);
  assert.equal(layout.edges.length, 2);
  assert.equal(layout.edges[0].from, 'prepare');
  assert.equal(layout.edges[0].to, 'submit');
});

test('block surfaces I/O, link, hard-rule, tacit counts', () => {
  const w = parseWorkflow(WF);
  const layout = layoutSwimlanes(w);
  const prepare = layout.blocks.find((b) => b.id === 'prepare')!;
  assert.equal(prepare.inputs, 1);
  assert.equal(prepare.outputs, 1);
  assert.equal(prepare.hasTacit, true);
  const verify = layout.blocks.find((b) => b.id === 'verify')!;
  assert.equal(verify.hasHardRule, true);
});

test('gapFor injection drives the block gap count', () => {
  const w = parseWorkflow(WF);
  // The "submit" step links app://bank-portal — flag it as a gap.
  const layout = layoutSwimlanes(w, {
    gapFor: (s) => (s.id === 'submit' ? 1 : 0),
  });
  const submit = layout.blocks.find((b) => b.id === 'submit')!;
  assert.equal(submit.gaps, 1);
  assert.equal(layout.blocks.find((b) => b.id === 'prepare')!.gaps, 0);
});

test('long step title is preserved in block.title (full value, not truncated at layout)', () => {
  const longTitle = 'A Very Long Step Title That Would Overflow Any Box';
  const w = parseWorkflow(`---
id: t
title: Test
domain: sales
visibility: Personal
status: draft
version: "1"
---

\`\`\`step
id: step1
title: ${longTitle}
actor: Human
\`\`\`
`);
  const layout = layoutSwimlanes(w);
  const block = layout.blocks.find((b) => b.id === 'step1')!;
  // Layout must carry the full title so the canvas can render a tooltip.
  assert.equal(block.title, longTitle);
  // Box must be wide enough to be rendered (BLOCK_W >= 200).
  assert.ok(block.w >= 200, `box width ${block.w} should be >= 200 to fit titles`);
});

test('empty workflow falls back to a single Human lane', () => {
  const w = parseWorkflow(`---
id: e
title: Empty
domain: sales
visibility: Personal
status: draft
version: "1"
---
`);
  const layout = layoutSwimlanes(w);
  assert.equal(layout.lanes.length, 1);
  assert.equal(layout.lanes[0].actor, 'Human');
  assert.equal(layout.blocks.length, 0);
});
