/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from './schema.ts';
import { parseSystem } from '../agents/system-schema.ts';
import { scaffoldSystem, defaultDisposition } from './agent-scaffold.ts';

const WF = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Shared
status: live
version: "1"
rules:
  - {id: wr1, text: "Never submit without sign-off", hard: true, scope: workflow}
---

\`\`\`step
id: prepare
title: Prepare Documents
actor: Human
actor_name: Officer
\`\`\`

\`\`\`step
id: submit
title: Submit to Bank
actor: Software
\`\`\`

\`\`\`step
id: verify
title: Verify Submission
actor: Agent
rules:
  - {id: sr1, text: "Error < 0.1%", hard: true}
\`\`\`
`;

test('defaultDisposition: Agent steps automate, others manual', () => {
  const wf = parseWorkflow(WF);
  assert.equal(defaultDisposition(wf.steps[0]), 'manual'); // Human
  assert.equal(defaultDisposition(wf.steps[2]), 'automate'); // Agent
});

test('default scaffold agentifies the Agent step, leaves others manual', () => {
  const out = scaffoldSystem(parseWorkflow(WF));
  assert.equal(out.agentSteps.length, 1);
  assert.equal(out.agentSteps[0].stepId, 'verify');
  assert.equal(out.manualSteps.length, 2);
});

test('the workflow is attached as context via grants.knowledge', () => {
  const out = scaffoldSystem(parseWorkflow(WF));
  assert.deepEqual(out.system.grants.knowledge, ['bank-submission']);
  assert.deepEqual(out.system.grants.tools, ['retrieve']);
});

test('a single agent needs no supervisor (it is the entrypoint)', () => {
  const out = scaffoldSystem(parseWorkflow(WF));
  assert.equal(out.system.agents.length, 1);
  assert.equal(out.system.entrypoint, out.system.agents[0].id);
});

test('multiple agentified steps get a supervisor + sequential handoffs', () => {
  const out = scaffoldSystem(parseWorkflow(WF), {
    dispositions: { prepare: 'augment', submit: 'automate', verify: 'automate' },
  });
  assert.equal(out.agentSteps.length, 3);
  assert.equal(out.system.entrypoint, 'supervisor');
  const sup = out.system.agents.find((a) => a.id === 'supervisor')!;
  assert.equal(sup.members?.length, 3);
  assert.equal(out.system.edges.filter((e) => e.type === 'handoff').length, 2);
});

test('hard rules (workflow + step) are pinned verbatim into the agent AGENT.md', () => {
  const out = scaffoldSystem(parseWorkflow(WF));
  const verifyAgent = out.system.agents.find((a) => a.id === 'verify')!;
  assert.ok(verifyAgent.agent_md.includes('Never submit without sign-off'));
  assert.ok(verifyAgent.agent_md.includes('Error < 0.1%'));
});

test('the scaffold yaml parses back as a valid System', () => {
  const out = scaffoldSystem(parseWorkflow(WF), {
    dispositions: { prepare: 'augment', verify: 'automate' },
  });
  const sys = parseSystem(out.yaml);
  assert.equal(sys.system.domain, 'sales');
  assert.ok(sys.agents.length >= 2);
});

test('all-manual workflow scaffolds a single coordinator with the workflow context', () => {
  const out = scaffoldSystem(parseWorkflow(WF), {
    dispositions: { prepare: 'manual', submit: 'manual', verify: 'manual' },
  });
  assert.equal(out.agentSteps.length, 0);
  assert.equal(out.system.agents.length, 1);
  assert.equal(out.system.agents[0].id, 'coordinator');
  assert.deepEqual(out.system.grants.knowledge, ['bank-submission']);
});
