/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from './schema.ts';
import { chunkWorkflow } from './chunk.ts';
import { compileGuardrails } from './guardrails.ts';
import { buildContextPack } from './context-pack.ts';
import {
  embedUnits,
  retrieveOffline,
  evaluateGolden,
  evaluateAccessControl,
  type GoldenCase,
  type AccessCase,
} from './eval-harness.ts';

/**
 * The eval harness in action + the "Bank submission" validation gate, end-to-end,
 * over the offline pipeline (deterministic, no cluster). This is the gate the
 * handover spec requires: a mixed-actor workflow with a linked data product + file,
 * a hard step-rule, an agent-captured tacit note; an agent answers grounded with
 * citations; a non-granted user is denied; pinned vs retrieved is assembled.
 */

const BANK_MD = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Shared
status: live
version: "1"
rules:
  - {id: wr1, text: "Bank quality over customer convenience", hard: false, scope: workflow}
  - {id: wr2, text: "Never submit a package without a signed checklist", hard: true, scope: workflow}
---

\`\`\`step
id: prepare
title: Prepare Documents
actor: Human
actor_name: Loan Officer
inputs: [Customer application]
outputs: [Document package]
links:
  - {type: data, ref: "sales.gold.customer_applications", label: Customer Applications}
  - {type: file, ref: "file:acme-contract.pdf", label: ACME Contract}
\`\`\`

> tacit: Loan officers often miss the income verification date in section 4 — always double-check.

\`\`\`step
id: submit
title: Submit to Bank Portal
actor: Software
actor_name: BankPortal
\`\`\`

\`\`\`step
id: verify
title: Verify Submission
actor: Agent
actor_name: Verification Agent
rules:
  - {id: sr1, text: "Submission error rate must stay below 0.1%", hard: true}
\`\`\`
`;

// A SEPARATE finance workflow that a sales user must never retrieve (access control).
const FINANCE_MD = `---
id: tax-filing
title: Tax Filing
domain: finance
visibility: Shared
status: live
version: "1"
---

\`\`\`step
id: compute
title: Compute Liability
actor: Agent
\`\`\`

> tacit: The finance secret handshake is the quarterly accrual reversal.
`;

function buildIndex() {
  const bank = chunkWorkflow({
    workflow: parseWorkflow(BANK_MD),
    owner: 'amir',
    tacit: '# Portal\nThe bank portal truncates notes over 500 characters; Friday-afternoon submissions slip to next week.',
    updatedAt: new Date().toISOString(),
  });
  const finance = chunkWorkflow({ workflow: parseWorkflow(FINANCE_MD), owner: 'kenji', updatedAt: new Date().toISOString() });
  return embedUnits([...bank, ...finance]);
}

const salesUser = { id: 'amir', domains: ['sales'], role: 'creator' as const };
const financeUser = { id: 'kenji', domains: ['finance'], role: 'creator' as const };

test('GOLDEN Q&A: grounded-answer rate is 100% on the golden set', () => {
  const units = buildIndex();
  const golden: GoldenCase[] = [
    { id: 'g1', query: 'income verification date section 4', principal: salesUser, expect: 'section 4' },
    { id: 'g2', query: 'error rate threshold for submission', principal: salesUser, expect: '0.1%' },
    { id: 'g3', query: 'signed checklist before submitting', principal: salesUser, expect: 'checklist' },
    { id: 'g4', query: 'which data product feeds prepare documents', principal: salesUser, expect: 'customer_applications' },
    { id: 'g5', query: 'bank portal note length limit friday', principal: salesUser, expect: 'truncates' },
  ];
  const report = evaluateGolden(units, golden);
  assert.equal(report.groundedRate, 1, `grounded ${report.grounded}/${report.total}: ${JSON.stringify(report.results.filter((r) => !r.grounded))}`);
});

test('ACCESS CONTROL: policy-violation rate is 0 (no cross-domain leak)', () => {
  const units = buildIndex();
  const cases: AccessCase[] = [
    // A sales user querying finance content must get ZERO finance units.
    { id: 'a1', query: 'secret handshake accrual reversal', principal: salesUser, forbiddenWorkflowId: 'tax-filing' },
    { id: 'a2', query: 'compute tax liability', principal: salesUser, forbiddenWorkflowId: 'tax-filing' },
    // A finance user must not see the sales bank-submission units.
    { id: 'a3', query: 'income verification date', principal: financeUser, forbiddenWorkflowId: 'bank-submission' },
  ];
  const report = evaluateAccessControl(units, cases);
  assert.equal(report.violations, 0, `leaks: ${JSON.stringify(report.results.filter((r) => r.violations))}`);
});

test('GATE: an agent answers grounded WITH CITATIONS (the tacit note is retrieved + citable)', () => {
  const units = buildIndex();
  const hits = retrieveOffline(units, 'income verification date section 4', salesUser, 6);
  const tacit = hits.find((h) => h.unit.text.includes('section 4'));
  assert.ok(tacit, 'the tacit note must be retrieved');
  assert.ok(tacit!.unit.id.length > 0, 'the cited unit has a provenance id (citation handle)');
});

test('GATE: a non-granted (cross-domain) user is DENIED the workflow content', () => {
  const units = buildIndex();
  const hits = retrieveOffline(units, 'prepare documents customer application', financeUser, 10);
  const leaked = hits.filter((h) => h.unit.provenance.workflowId === 'bank-submission');
  assert.equal(leaked.length, 0);
});

test('GATE: the hard step-rule compiles to an OPA guardrail', () => {
  const wf = parseWorkflow(BANK_MD);
  const compiled = compileGuardrails(wf);
  const ids = compiled.guardrails.map((g) => g.text);
  assert.ok(ids.some((t) => t.includes('error rate must stay below 0.1%')), 'the hard step rule is a guardrail');
  assert.ok(ids.some((t) => t.includes('signed checklist')), 'the hard workflow rule is a guardrail');
  // Soft rule excluded.
  assert.ok(!ids.some((t) => t.includes('customer convenience')));
});

test('GATE: the context pack pins the hard rules + steps and adds the reranked tail', () => {
  const units = buildIndex();
  const bankUnits = units.filter((u) => u.provenance.workflowId === 'bank-submission');
  const steps = bankUnits.filter((u) => u.provenance.type === 'workflow');
  const hard = bankUnits.filter((u) => u.id.includes(':rule:wr2') || u.id.includes(':rule:sr1'));
  const retrieved = retrieveOffline(units, 'income verification date', salesUser, 6);
  const pack = buildContextPack({ domainCard: [], workflowSteps: steps, hardRules: hard, retrieved, budget: 2000 });
  assert.ok(pack.items.some((i) => i.kind === 'hard-rule'), 'hard rules pinned');
  assert.ok(pack.items.some((i) => i.kind === 'workflow-step'), 'steps pinned');
  assert.ok(pack.totalTokens <= pack.budget, 'within budget');
});
