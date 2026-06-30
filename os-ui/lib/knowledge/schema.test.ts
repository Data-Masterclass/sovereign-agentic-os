/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflow,
  serializeWorkflow,
  KnowledgeError,
  emptyDomainKnowledge,
  DOMAIN_SECTION_IDS,
} from './schema.ts';

const VALID_WORKFLOW = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Personal
status: draft
version: "1"
rules:
  - id: r1
    text: Quality over customer convenience
    hard: false
    scope: workflow
  - id: r2
    text: Error rate must be below 0.1%
    hard: true
    scope: step
    step_id: verify
---

\`\`\`step
id: prepare-documents
title: Prepare Documents
actor: Human
actor_name: Loan Officer
inputs:
  - Customer application form
outputs:
  - Document package
links:
  - type: data
    ref: sales.gold.customer_applications
    label: Customer Applications
rules:
  - id: sr1
    text: All required fields must be completed
    hard: false
\`\`\`

> tacit: Loan officers often miss the income verification date in section 4.

\`\`\`step
id: submit-to-bank
title: Submit to Bank Portal
actor: Software
actor_name: BankPortal
links:
  - type: app
    ref: app://bank-portal
    label: Bank Portal
rules:
  - id: sr2
    text: Error rate must be below 0.1%
    hard: true
\`\`\`

\`\`\`step
id: verify
title: Verify Submission
actor: Agent
actor_name: Verification Agent
outputs:
  - Submission receipt
links:
  - type: agent
    ref: sys_verify_agent
    label: Verification Agent
\`\`\`
`;

test('parses a valid workflow.md', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.id, 'bank-submission');
  assert.equal(w.title, 'Bank Submission');
  assert.equal(w.domain, 'sales');
  assert.equal(w.visibility, 'Personal');
  assert.equal(w.status, 'draft');
  assert.equal(w.version, '1');
});

test('parses workflow-level rules', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.rules.length, 2);
  assert.equal(w.rules[0].id, 'r1');
  assert.equal(w.rules[0].hard, false);
  assert.equal(w.rules[0].scope, 'workflow');
  assert.equal(w.rules[1].hard, true);
  assert.equal(w.rules[1].scope, 'step');
  assert.equal(w.rules[1].step_id, 'verify');
});

test('parses three step blocks', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.steps.length, 3);
});

test('parses step metadata — actor, I/O, links, step-level rules', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const s0 = w.steps[0];
  assert.equal(s0.id, 'prepare-documents');
  assert.equal(s0.actor, 'Human');
  assert.equal(s0.actor_name, 'Loan Officer');
  assert.deepEqual(s0.inputs, ['Customer application form']);
  assert.deepEqual(s0.outputs, ['Document package']);
  assert.equal(s0.links.length, 1);
  assert.equal(s0.links[0].type, 'data');
  assert.equal(s0.links[0].ref, 'sales.gold.customer_applications');
  assert.equal(s0.links[0].label, 'Customer Applications');
  assert.equal(s0.rules.length, 1);
  assert.equal(s0.rules[0].hard, false);
});

test('parses inline tacit note after first step', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.ok(w.steps[0].tacit.includes('section 4'), `expected tacit note; got: ${w.steps[0].tacit}`);
});

test('step with no tacit note has empty tacit string', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.steps[2].tacit, '');
});

test('Software and Agent actors parse correctly', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.steps[1].actor, 'Software');
  assert.equal(w.steps[2].actor, 'Agent');
});

test('round-trip: serialize → parse returns equivalent data', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const serialized = serializeWorkflow(w);
  const again = parseWorkflow(serialized);
  assert.equal(again.id, w.id);
  assert.equal(again.title, w.title);
  assert.equal(again.steps.length, w.steps.length);
  assert.equal(again.steps[0].actor, 'Human');
  assert.equal(again.steps[1].actor, 'Software');
  assert.equal(again.steps[2].actor, 'Agent');
  assert.equal(again.rules.length, w.rules.length);
});

test('round-trip preserves tacit notes', () => {
  const w = parseWorkflow(VALID_WORKFLOW);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.ok(again.steps[0].tacit.includes('section 4'));
});

test('throws KnowledgeError when frontmatter is missing', () => {
  assert.throws(() => parseWorkflow('# No frontmatter'), KnowledgeError);
});

test('throws KnowledgeError on invalid visibility', () => {
  const bad = VALID_WORKFLOW.replace('visibility: Personal', 'visibility: Secret');
  assert.throws(() => parseWorkflow(bad), KnowledgeError);
});

test('throws KnowledgeError on invalid status', () => {
  const bad = VALID_WORKFLOW.replace('status: draft', 'status: pending');
  assert.throws(() => parseWorkflow(bad), KnowledgeError);
});

test('emptyDomainKnowledge returns four sections', () => {
  const dk = emptyDomainKnowledge('sales');
  assert.equal(dk.domain, 'sales');
  assert.equal(dk.sections.length, 4);
  for (const id of DOMAIN_SECTION_IDS) {
    assert.ok(dk.sections.some((s) => s.id === id), `missing section ${id}`);
  }
});
