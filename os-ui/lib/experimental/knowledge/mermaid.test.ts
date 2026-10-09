/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from './schema.ts';
import { renderMermaid } from './mermaid.ts';

const WF = `---
id: wf
title: WF
domain: sales
visibility: Personal
status: draft
version: "1"
---

\`\`\`step
id: prepare
title: Prepare
actor: Human
actor_name: Officer
\`\`\`

\`\`\`step
id: submit
title: Submit
actor: Software
\`\`\`

\`\`\`step
id: verify
title: Verify
actor: Agent
rules:
  - {id: r1, text: hard, hard: true}
\`\`\`
`;

test('renders flowchart LR header', () => {
  assert.ok(renderMermaid(parseWorkflow(WF)).startsWith('flowchart LR'));
});

test('emits one node per step with actor-shaped syntax', () => {
  const out = renderMermaid(parseWorkflow(WF));
  assert.ok(out.includes('(["Prepare'), 'Human → stadium'); // stadium
  assert.ok(out.includes('["Submit'), 'Software → rectangle');
  assert.ok(out.includes('{{"Verify'), 'Agent → hexagon');
});

test('emits sequential edges between steps', () => {
  const out = renderMermaid(parseWorkflow(WF));
  assert.ok(out.includes('prepare --> submit'));
  assert.ok(out.includes('submit --> verify'));
});

test('hard-rule step gets a lock mark', () => {
  const out = renderMermaid(parseWorkflow(WF));
  assert.ok(out.includes('🔒'), 'expected lock for the hard-rule step');
});

test('emits actor classDefs + class assignments', () => {
  const out = renderMermaid(parseWorkflow(WF));
  assert.ok(out.includes('classDef human'));
  assert.ok(out.includes('classDef software'));
  assert.ok(out.includes('classDef agent'));
  assert.ok(/class prepare human/.test(out));
});

test('node labels break lines with <br/>, never a raw newline', () => {
  const out = renderMermaid(parseWorkflow(WF));
  // The actor line must be separated with a Mermaid-safe <br/>, and no raw
  // newline may appear inside a quoted node label (which would break parsing).
  assert.ok(out.includes('Prepare<br/>(Human: Officer)'), 'actor tag joined with <br/>');
  for (const line of out.split('\n')) {
    const quoted = line.match(/"([^"]*)"/);
    if (quoted) assert.ok(!quoted[1].includes('\n'), 'no raw newline inside a label');
  }
});

test('empty workflow renders a placeholder node', () => {
  const out = renderMermaid(parseWorkflow(`---
id: e
title: E
domain: sales
visibility: Personal
status: draft
version: "1"
---
`));
  assert.ok(out.includes('No steps yet'));
});
