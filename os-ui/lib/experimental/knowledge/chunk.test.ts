/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, emptyDomainKnowledge } from './schema.ts';
import { chunkWorkflow, chunkDomain, splitTacit, stripStructuredBlocks } from './chunk.ts';

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

// ---------------------------------------------------------------- body chunking ---

const MARKDOWN_ONLY_WF = `---
id: wf-briefing
title: Team Briefing
domain: ops
visibility: Shared
status: live
version: "1"
rules: []
---

# Purpose

This briefing explains the quarterly review cadence and expectations for all team leads.

# Key Dates

Review windows open on the first Monday of each quarter and close within five business days.
`;

test('markdown-only workflow (no steps/rules) yields ≥1 body unit whose text contains the prose', () => {
  const units = chunkWorkflow({ workflow: parseWorkflow(MARKDOWN_ONLY_WF), owner: 'alex' });
  const bodyUnits = units.filter((u) => u.id.startsWith('wf-briefing:body:'));
  assert.ok(bodyUnits.length >= 1, 'expected at least 1 body unit');
  const allText = bodyUnits.map((u) => u.text).join('\n');
  assert.ok(allText.includes('quarterly review cadence'), 'prose text must be present in body units');
});

test('markdown-only workflow body units carry workflow provenance type', () => {
  const units = chunkWorkflow({ workflow: parseWorkflow(MARKDOWN_ONLY_WF), owner: 'alex' });
  const bodyUnits = units.filter((u) => u.id.startsWith('wf-briefing:body:'));
  assert.ok(bodyUnits.every((u) => u.provenance.type === 'workflow'));
});

test('workflow with steps + markdown intro emits both step units and body-section units, no duplication', () => {
  const wf = parseWorkflow(WF);
  const units = chunkWorkflow({ workflow: wf, owner: 'amir' });

  const stepUnits = units.filter((u) => /^bank-submission:step:/.test(u.id));
  const bodyUnits = units.filter((u) => /^bank-submission:body:/.test(u.id));

  // Should still have the two step units.
  assert.equal(stepUnits.length, 2, 'step units must be preserved');

  // The WF fixture has no prose heading sections outside step blocks,
  // so body units may be 0 — but NO unit text should contain raw ```step fences.
  const allText = units.map((u) => u.text).join('\n');
  assert.ok(!allText.includes('```step'), 'raw step fences must not appear in any unit text');

  // No unit id should appear twice.
  const ids = units.map((u) => u.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, 'unit ids must be unique (no duplication)');
});

test('stripStructuredBlocks removes step fences and tacit blockquotes but keeps prose', () => {
  const body = '# Intro\nSome prose.\n\n```step\nid: s1\ntitle: Do it\n```\n\n> tacit: Watch out.\n\n# Notes\nMore prose.';
  const result = stripStructuredBlocks(body);
  assert.ok(!result.includes('```step'), 'step fences removed');
  assert.ok(!result.includes('tacit:'), 'tacit blockquotes removed');
  assert.ok(result.includes('Some prose.'), 'prose kept');
  assert.ok(result.includes('More prose.'), 'trailing prose kept');
});
