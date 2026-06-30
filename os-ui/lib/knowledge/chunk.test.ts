/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, emptyDomainKnowledge } from './schema.ts';
import { chunkWorkflow, chunkDomain, splitTacit } from './chunk.ts';

const WF = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Shared
status: live
version: "2"
rules:
  - {id: wr1, text: "Quality over speed", hard: true, scope: workflow}
---

\`\`\`step
id: prepare
title: Prepare
actor: Human
actor_name: Officer
inputs: [Application]
outputs: [Package]
links:
  - {type: data, ref: "sales.gold.apps", label: Apps}
rules:
  - {id: sr1, text: "All fields required", hard: false}
\`\`\`

> tacit: Watch the date in section 4.

\`\`\`step
id: verify
title: Verify
actor: Agent
rules:
  - {id: sr2, text: "Error < 0.1%", hard: true}
\`\`\`
`;

test('chunkWorkflow emits one unit per step', () => {
  const units = chunkWorkflow({ workflow: parseWorkflow(WF), owner: 'amir' });
  const stepUnits = units.filter((u) => u.provenance.type === 'workflow');
  assert.equal(stepUnits.length, 2);
});

test('step units carry provenance: domain, workflow, step, actor, version, visibility', () => {
  const units = chunkWorkflow({ workflow: parseWorkflow(WF), owner: 'amir' });
  const prepare = units.find((u) => u.id === 'bank-submission:step:prepare')!;
  assert.equal(prepare.provenance.domain, 'sales');
  assert.equal(prepare.provenance.workflowId, 'bank-submission');
  assert.equal(prepare.provenance.stepId, 'prepare');
  assert.equal(prepare.provenance.actor, 'Human');
  assert.equal(prepare.provenance.version, '2');
  assert.equal(prepare.provenance.visibility, 'Shared');
});

test('inline tacit note becomes its own tacit unit', () => {
  const units = chunkWorkflow({ workflow: parseWorkflow(WF), owner: 'amir' });
  const t = units.find((u) => u.id === 'bank-submission:tacit:prepare');
  assert.ok(t);
  assert.equal(t!.provenance.type, 'tacit');
  assert.ok(t!.text.includes('section 4'));
});

test('rules become rule units; hard rules rank higher authority + trust', () => {
  const units = chunkWorkflow({ workflow: parseWorkflow(WF), owner: 'amir' });
  const hard = units.find((u) => u.id === 'bank-submission:rule:sr2')!; // hard step rule
  const soft = units.find((u) => u.id === 'bank-submission:rule:sr1')!; // soft step rule
  assert.equal(hard.provenance.authority, 1.0);
  assert.equal(soft.provenance.authority, 0.6);
  assert.ok(hard.provenance.trust > soft.provenance.trust);
});

test('workflow tacit.md splits into heading sections', () => {
  const tacit = '# A\nalpha note\n\n# B\nbeta note';
  const units = chunkWorkflow({ workflow: parseWorkflow(WF), owner: 'amir', tacit });
  const docTacit = units.filter((u) => u.id.startsWith('bank-submission:tacit:doc:'));
  assert.equal(docTacit.length, 2);
});

test('visibility drives base trust (Shared = 0.7 baseline)', () => {
  const units = chunkWorkflow({ workflow: parseWorkflow(WF), owner: 'amir' });
  const step = units.find((u) => u.provenance.type === 'workflow')!;
  assert.equal(step.provenance.trust, 0.7);
});

test('chunkDomain emits a unit per non-empty section', () => {
  const dk = emptyDomainKnowledge('sales');
  dk.sections[0].content = 'Overview text';
  dk.sections[1].content = 'Glossary text';
  const units = chunkDomain(dk);
  assert.equal(units.length, 2);
  assert.equal(units[0].provenance.type, 'domain');
});

test('splitTacit returns one section when there are no headings', () => {
  const out = splitTacit('just a paragraph with no heading');
  assert.equal(out.length, 1);
  assert.equal(out[0].heading, '');
});
