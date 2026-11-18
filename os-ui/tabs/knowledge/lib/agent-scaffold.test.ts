/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '@tabs/knowledge/lib/schema';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { scaffoldSystem, defaultDisposition, assertUniqueAgentIds } from '@tabs/knowledge/lib/agent-scaffold';
import { actorAgentMd } from '@tabs/knowledge/lib/actor-prompt';

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
  assert.deepEqual(out.system.grants.knowledge, [{ id: 'bank-submission', capability: 'Read' }]);
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

// ------------------------------------------------ one agent per AGENT ACTOR ---
// The steps of an Agent actor are that actor's work, so they belong to ONE agent
// carrying the actor's long prompt — not to one agent each.
const WF_REG = `---
id: refunds
title: Refunds
domain: sales
visibility: Shared
status: live
version: "1"
rules:
  - {id: wr1, text: "Never refund without a verified order", hard: true, scope: workflow}
actors:
  - id: actor-agent-triage-bot
    name: Triage Bot
    category: Agent
    prompt: |-
      # Triage Bot

      You are the refunds triage desk.
  - {id: actor-human-officer, name: Support Agent, category: Human}
---

\`\`\`step
id: intake
title: Intake Request
actor: Agent
actor_name: Triage Bot
outputs: [Triage verdict]
\`\`\`

\`\`\`step
id: review
title: Review Evidence
actor: Human
actor_name: Support Agent
\`\`\`

\`\`\`step
id: decide
title: Decide Refund
actor: Agent
actor_name: Triage Bot
rules:
  - {id: sr1, text: "Over 500 EUR needs a manager", hard: true}
\`\`\`
`;

test('an Agent actor with two steps scaffolds ONE agent, keyed by the actor', () => {
  const out = scaffoldSystem(parseWorkflow(WF_REG));
  assert.equal(out.actorAgents.length, 1);
  assert.deepEqual(out.actorAgents[0], {
    actorId: 'actor-agent-triage-bot',
    agentId: 'triage-bot',
    actorName: 'Triage Bot',
    stepIds: ['intake', 'decide'],
  });
  assert.equal(out.agentSteps.length, 0, 'no per-step agent for an actor-owned step');
  assert.deepEqual(out.manualSteps.map((m) => m.stepId), ['review']);
  assert.equal(out.system.agents.length, 1);
  assert.equal(out.system.entrypoint, 'triage-bot');
});

test('the actor agent’s AGENT.md is actorAgentMd, byte for byte', () => {
  const wf = parseWorkflow(WF_REG);
  const out = scaffoldSystem(wf);
  const agent = out.system.agents.find((a) => a.id === 'triage-bot')!;
  const actor = wf.actors.find((a) => a.name === 'Triage Bot')!;
  assert.equal(agent.agent_md, actorAgentMd(wf, actor));
  // and it really is the author's prompt plus the steps
  assert.match(
    agent.agent_md,
    /^--- author-supplied agent prompt;[^\n]*---\n# Triage Bot\n\nYou are the refunds triage desk\.\n--- end author-supplied agent prompt ---\n/,
  );
  assert.match(agent.agent_md, /### 1\. Intake Request/);
  assert.match(agent.agent_md, /### 2\. Decide Refund/);
  assert.match(agent.agent_md, /- HARD RULE: Over 500 EUR needs a manager/);
  assert.match(agent.agent_md, /Never refund without a verified order/);
});

test('the actor agent names the actor in its role and keeps the retrieve tool', () => {
  const out = scaffoldSystem(parseWorkflow(WF_REG));
  const agent = out.system.agents.find((a) => a.id === 'triage-bot')!;
  assert.match(agent.role, /Triage Bot/);
  assert.deepEqual(agent.tools, ['retrieve']);
});

test('a Human-actor step set to automate becomes an agent beside the actor agent', () => {
  const out = scaffoldSystem(parseWorkflow(WF_REG), { dispositions: { review: 'automate' } });
  assert.equal(out.actorAgents.length, 1);
  assert.equal(out.agentSteps.length, 1);
  assert.equal(out.agentSteps[0].stepId, 'review');
  assert.equal(out.system.entrypoint, 'supervisor');
  const sup = out.system.agents.find((a) => a.id === 'supervisor')!;
  assert.deepEqual(sup.members, ['triage-bot', 'review'], 'members follow workflow order');
  assert.equal(out.system.edges.filter((e) => e.type === 'handoff').length, 1);
});

test('the scaffold yaml with an actor agent parses back as a valid System', () => {
  const out = scaffoldSystem(parseWorkflow(WF_REG), { dispositions: { review: 'augment' } });
  const sys = parseSystem(out.yaml);
  assert.equal(sys.system.domain, 'sales');
  assert.deepEqual(sys.agents.map((a) => a.id).sort(), ['review', 'supervisor', 'triage-bot']);
  const agent = sys.agents.find((a) => a.id === 'triage-bot')!;
  assert.ok(agent.agent_md.includes('You are the refunds triage desk.'), 'the prompt survives the yaml');
});

// ------------------ review H1: the scaffold's own node ids are not up for grabs ---
const WF_RESERVED = `---
id: reserved
title: Reserved
domain: sales
visibility: Shared
status: live
version: "1"
actors:
  - {id: actor-agent-supervisor, name: Supervisor, category: Agent}
  - {id: actor-human-officer, name: Officer, category: Human}
---

\`\`\`step
id: route
title: Route It
actor: Agent
actor_name: Supervisor
\`\`\`

\`\`\`step
id: check
title: Check It
actor: Human
actor_name: Officer
\`\`\`
`;

test('an actor named "Supervisor" cannot collide with the supervisor node', () => {
  const out = scaffoldSystem(parseWorkflow(WF_RESERVED), { dispositions: { check: 'automate' } });
  const ids = out.system.agents.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate agent id: ${ids.join(', ')}`);
  assert.ok(ids.includes('supervisor'), 'the graph keeps its supervisor');
  assert.equal(out.actorAgents[0].agentId, 'supervisor-2');
  const sup = out.system.agents.find((a) => a.id === 'supervisor')!;
  assert.ok(!sup.members?.includes('supervisor'), 'a supervisor must never list itself');
  assert.deepEqual(sup.members, ['supervisor-2', 'check']);
  parseSystem(out.yaml); // and it is still a valid System
});

test('assertUniqueAgentIds refuses a graph with a duplicate id', () => {
  // The guard the scaffold runs on its own output: `parseSystem` has no duplicate-id check
  // (and adding one there would be another tab's business), so a broken graph could commit.
  const spec = (id: string) => ({ id, role: '', agent_md: '', memory_md: '' });
  assert.throws(
    () => assertUniqueAgentIds([spec('a'), spec('b'), spec('a')]),
    /duplicate agent id 'a'/,
  );
  assertUniqueAgentIds([spec('a'), spec('b')]); // does not throw
});

test('an Agent actor with no steps yields no agent (review M3)', () => {
  const WF_IDLE = `---
id: idle
title: Idle
domain: sales
visibility: Personal
status: draft
version: "1"
actors:
  - {id: actor-agent-idle, name: Idle Bot, category: Agent}
---

\`\`\`step
id: hand
title: Hand It Over
actor: Human
actor_name: Officer
\`\`\`
`;
  const out = scaffoldSystem(parseWorkflow(WF_IDLE));
  assert.equal(out.actorAgents.length, 0);
  assert.equal(out.agentSteps.length, 0);
  assert.deepEqual(out.system.agents.map((a) => a.id), ['coordinator']);
});

test('all-manual workflow scaffolds a single coordinator with the workflow context', () => {
  const out = scaffoldSystem(parseWorkflow(WF), {
    dispositions: { prepare: 'manual', submit: 'manual', verify: 'manual' },
  });
  assert.equal(out.agentSteps.length, 0);
  assert.equal(out.system.agents.length, 1);
  assert.equal(out.system.agents[0].id, 'coordinator');
  assert.deepEqual(out.system.grants.knowledge, [{ id: 'bank-submission', capability: 'Read' }]);
});
