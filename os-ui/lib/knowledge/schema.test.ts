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

// ------------------------------------------------------------ actors ---------

const WORKFLOW_WITH_ACTORS = `---
id: onboarding
title: Partner Onboarding
domain: sales
visibility: Personal
status: draft
version: "1"
actors:
  - name: Loan Officer
    category: Human
    description: Approves deals over EUR 50k.
  - name: Salesforce API
    category: Software
    description: Nightly REST ingestion of leads.
  - name: Campaign Optimizer
    category: Agent
    description: The OS agent system that tunes spend.
  - name: Acme Buyer
    category: Customer
    description: The external customer placing the order.
  - name: Fulfilment Partner
    category: Partner
    description: External 3PL that ships the goods.
---

\`\`\`step
id: intake
title: Intake request
actor: Customer
actor_name: Acme Buyer
\`\`\`

\`\`\`step
id: sync
title: Sync to CRM
actor: Software
actor_name: Salesforce API
\`\`\`

\`\`\`step
id: ship
title: Hand to fulfilment
actor: Partner
actor_name: Fulfilment Partner
\`\`\`
`;

test('parses the five actor categories on steps', () => {
  const w = parseWorkflow(WORKFLOW_WITH_ACTORS);
  assert.equal(w.steps[0].actor, 'Customer');
  assert.equal(w.steps[1].actor, 'Software');
  assert.equal(w.steps[2].actor, 'Partner');
});

test('parses the actors registry with descriptions incl external', () => {
  const w = parseWorkflow(WORKFLOW_WITH_ACTORS);
  assert.equal(w.actors.length, 5);
  const officer = w.actors.find((a) => a.name === 'Loan Officer');
  assert.equal(officer?.category, 'Human');
  assert.equal(officer?.description, 'Approves deals over EUR 50k.');
  const buyer = w.actors.find((a) => a.name === 'Acme Buyer');
  assert.equal(buyer?.category, 'Customer');
  const partner = w.actors.find((a) => a.name === 'Fulfilment Partner');
  assert.equal(partner?.category, 'Partner');
  assert.ok(partner?.description?.includes('3PL'));
});

test('round-trip: serialize → parse preserves the actors registry (incl external + descriptions)', () => {
  const w = parseWorkflow(WORKFLOW_WITH_ACTORS);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.equal(again.actors.length, 5);
  for (const a of w.actors) {
    const match = again.actors.find((x) => x.category === a.category && x.name === a.name);
    assert.ok(match, `actor ${a.category}:${a.name} lost on round-trip`);
    assert.equal(match?.description, a.description);
  }
  assert.equal(again.steps[0].actor, 'Customer');
  assert.equal(again.steps[2].actor, 'Partner');
});

test('back-compat: an old workflow.md with NO actors section derives a registry from steps', () => {
  // VALID_WORKFLOW predates the actors section — parsing must not crash and the
  // registry is derived from the steps' distinct (category, name) pairs.
  const w = parseWorkflow(VALID_WORKFLOW);
  assert.equal(w.actors.length, 3);
  assert.deepEqual(
    w.actors.map((a) => `${a.category}:${a.name}`).sort(),
    ['Agent:Verification Agent', 'Human:Loan Officer', 'Software:BankPortal'].sort(),
  );
  // Derived actors carry no description (none was declared).
  assert.ok(w.actors.every((a) => a.description === undefined));
});

test('emptyDomainKnowledge returns four sections', () => {
  const dk = emptyDomainKnowledge('sales');
  assert.equal(dk.domain, 'sales');
  assert.equal(dk.sections.length, 4);
  for (const id of DOMAIN_SECTION_IDS) {
    assert.ok(dk.sections.some((s) => s.id === id), `missing section ${id}`);
  }
});
