/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from './schema.ts';
import { findGaps, stepGapCount, isGap, type EntityIndex } from './gaps.ts';

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
title: Prepare
actor: Human
links:
  - {type: data, ref: "sales.gold.customer_applications", label: Apps}
\`\`\`

\`\`\`step
id: submit
title: Submit
actor: Software
links:
  - {type: app, ref: "app://bank-portal", label: Bank Portal}
\`\`\`
`;

const index = (): EntityIndex => ({
  data: new Set(['sales.gold.customer_applications']), // exists
  app: new Set(), // bank-portal MISSING → gap
  agent: new Set(),
  file: new Set(),
});

test('isGap: present entity is not a gap; missing is', () => {
  const w = parseWorkflow(WF);
  const idx = index();
  assert.equal(isGap(w.steps[0].links[0], idx), false);
  assert.equal(isGap(w.steps[1].links[0], idx), true);
});

test('stepGapCount counts only missing links', () => {
  const w = parseWorkflow(WF);
  const idx = index();
  assert.equal(stepGapCount(w.steps[0], idx), 0);
  assert.equal(stepGapCount(w.steps[1], idx), 1);
});

test('findGaps returns the missing app with a software jump-to-build', () => {
  const w = parseWorkflow(WF);
  const gaps = findGaps(w, index());
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].stepId, 'submit');
  assert.equal(gaps[0].link.type, 'app');
  assert.equal(gaps[0].buildTab, 'software');
  assert.ok(gaps[0].buildHref.startsWith('/software?'));
  assert.ok(gaps[0].buildHref.includes('from=knowledge'));
  assert.ok(gaps[0].buildHref.includes('workflow=bank-submission'));
});

test('with an empty index, every link is a gap', () => {
  const w = parseWorkflow(WF);
  const gaps = findGaps(w);
  assert.equal(gaps.length, 2);
});

test('jump-to-build tab maps per link type', () => {
  const w = parseWorkflow(`---
id: t
title: T
domain: sales
visibility: Personal
status: draft
version: "1"
---

\`\`\`step
id: a
title: A
actor: Human
links:
  - {type: data, ref: d}
  - {type: app, ref: ap}
  - {type: agent, ref: ag}
  - {type: file, ref: f}
\`\`\`
`);
  const gaps = findGaps(w);
  const tabs = Object.fromEntries(gaps.map((g) => [g.link.type, g.buildTab]));
  assert.deepEqual(tabs, { data: 'data', app: 'software', agent: 'agents', file: 'unstructured' });
});
