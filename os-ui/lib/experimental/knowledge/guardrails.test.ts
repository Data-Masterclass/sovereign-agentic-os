/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from './schema.ts';
import { collectGuardrails, compileGuardrails } from './guardrails.ts';

const WF = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Personal
status: draft
version: "1"
rules:
  - {id: wr1, text: "Quality over convenience", hard: false, scope: workflow}
  - {id: wr2, text: "Never submit without sign-off", hard: true, scope: workflow}
---

\`\`\`step
id: verify
title: Verify
actor: Agent
rules:
  - {id: sr1, text: "Error rate < 0.1%", hard: true}
  - {id: sr2, text: "Prefer the fast path", hard: false}
\`\`\`
`;

test('collectGuardrails returns only HARD rules (workflow + step)', () => {
  const g = collectGuardrails(parseWorkflow(WF));
  const ids = g.map((x) => x.id).sort();
  assert.deepEqual(ids, ['sr1', 'wr2']); // wr1, sr2 are soft → excluded
});

test('step hard rule carries the step id + title', () => {
  const g = collectGuardrails(parseWorkflow(WF));
  const sr1 = g.find((x) => x.id === 'sr1')!;
  assert.equal(sr1.level, 'step');
  assert.equal(sr1.stepId, 'verify');
  assert.equal(sr1.stepTitle, 'Verify');
});

test('compileGuardrails emits package path, data + Rego', () => {
  const c = compileGuardrails(parseWorkflow(WF));
  assert.equal(c.packagePath, 'agentic.knowledge.bank_submission');
  assert.equal(c.data.guardrails.length, 2);
  assert.ok(c.rego.includes('package agentic.knowledge.bank_submission'));
  assert.ok(c.rego.includes('default allow := false'));
  assert.ok(c.rego.includes('allow if'));
});

test('soft rules are NOT in the compiled data', () => {
  const c = compileGuardrails(parseWorkflow(WF));
  const ids = c.data.guardrails.map((g) => g.id);
  assert.ok(!ids.includes('wr1'));
  assert.ok(!ids.includes('sr2'));
});

test('a workflow with no hard rules compiles to an allow-all (soft only)', () => {
  const w = parseWorkflow(`---
id: soft
title: Soft
domain: sales
visibility: Personal
status: draft
version: "1"
rules:
  - {id: x, text: "guidance", hard: false, scope: workflow}
---
`);
  const c = compileGuardrails(w);
  assert.equal(c.guardrails.length, 0);
  assert.ok(c.rego.includes('allow := true'));
});
