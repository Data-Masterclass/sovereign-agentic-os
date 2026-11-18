/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The AGENT.md an Agent actor's prompt + its steps compile into, and the agent plan
 * USER STORY: As a process owner I write one long prompt for an Agent actor and expect the steps I
 *             assigned to it to appear in that agent's instructions, in order, with their expert
 *             knowledge and hard rules — and exactly one agent per actor, not one per step.
 * ARCHITECTURE:
 *   - Pins the AGENT.md as a WHOLE STRING for one fixture, because the file is the product: a test
 *     that only greps for substrings cannot catch a section landing in the wrong place.
 *   - `actorAgentMd` is a pure function of (workflow, actor) — no dispositions — so the editor's
 *     preview and the scaffold's output are the same bytes. `agent-scaffold.test.ts` asserts that.
 *   - The grouping is tested through `planAgents` rather than the scaffold, so the System schema
 *     (the one cross-tab import on this path) is not in the way of the rules under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, type Actor } from '@tabs/knowledge/lib/schema';
import {
  actorAgentMd,
  agentIdForActor,
  defaultDisposition,
  planAgents,
} from '@tabs/knowledge/lib/actor-prompt';

const PROMPT = [
  '# Triage Bot',
  '',
  'You are the triage desk for inbound bank submissions.',
  '--- escalate to the desk head ---',
  '```',
  'json',
  '```',
  '',
  'Always answer in English.',
].join('\n');

/** Two steps for ONE Agent actor, plus a Human and a Software step. */
const WF = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Shared
status: live
version: "1"
rules:
  - {id: wr1, text: "Never submit without sign-off", hard: true, scope: workflow}
  - {id: wr2, text: "Prefer a same-day turnaround", hard: false, scope: workflow}
  - {id: wr3, text: "Error < 0.1%", hard: true, scope: step, step_id: verify}
actors:
  - id: actor-agent-triage-bot
    name: Triage Bot
    category: Agent
    description: Triages inbound submissions.
    prompt: |-
${PROMPT.split('\n').map((l) => (l ? `      ${l}` : '')).join('\n')}
  - {id: actor-human-officer, name: Loan Officer, category: Human}
  - {id: actor-software-portal, name: BankPortal, category: Software}
---

\`\`\`step
id: triage
title: Triage Submission
actor: Agent
actor_name: Triage Bot
inputs: [Customer application form]
outputs: [Triage verdict]
links:
  - {type: data, ref: sales.gold.customer_applications, label: Customer Applications}
rules:
  - {id: sr1, text: "Reject an unsigned form", hard: true}
  - {id: sr2, text: "Prefer the newest address", hard: false}
\`\`\`

> tacit: Check section 4 — the date field is frequently missed.
> tacit: Two lines, deliberately.

\`\`\`step
id: prepare
title: Prepare Documents
actor: Human
actor_name: Loan Officer
\`\`\`

\`\`\`step
id: verify
title: Verify Submission
actor: Agent
actor_name: Triage Bot
outputs: [Submission receipt]
\`\`\`

\`\`\`step
id: submit
title: Submit to Bank Portal
actor: Software
actor_name: BankPortal
\`\`\`
`;

const wf = parseWorkflow(WF);
const triageBot = wf.actors.find((a) => a.name === 'Triage Bot')!;

// --------------------------------------------------------------- the AGENT.md ---

test('the fixture parses: the Agent actor keeps its multi-line prompt', () => {
  assert.equal(triageBot.prompt, PROMPT);
});

test('the AGENT.md is the prompt verbatim, then the steps, then the workflow hard rules', () => {
  const expected = [
    PROMPT,
    '',
    '## Your steps in the Bank Submission workflow',
    '',
    '### 1. Triage Submission',
    '- Inputs: Customer application form',
    '- Outputs: Triage verdict',
    '- Linked entities: data:Customer Applications',
    '- Expert knowledge: Check section 4 — the date field is frequently missed.',
    '  Two lines, deliberately.',
    '- HARD RULE: Reject an unsigned form',
    '',
    '### 2. Verify Submission',
    '- Outputs: Submission receipt',
    '- HARD RULE: Error < 0.1%',
    '',
    '## Hard rules for the whole Bank Submission workflow',
    '- Never submit without sign-off',
    '',
    'Use the granted, governed `retrieve` tool to pull this workflow’s steps, expert-knowledge notes and rules as needed.',
  ].join('\n');
  assert.equal(actorAgentMd(wf, triageBot), expected);
});

test('the author’s prompt leads the file, unedited', () => {
  assert.ok(actorAgentMd(wf, triageBot).startsWith(PROMPT));
});

test('only the actor’s own steps are listed, and in workflow order', () => {
  const md = actorAgentMd(wf, triageBot);
  assert.ok(md.indexOf('### 1. Triage Submission') < md.indexOf('### 2. Verify Submission'));
  assert.ok(!md.includes('Prepare Documents'), 'another actor’s step must not appear');
  assert.ok(!md.includes('Submit to Bank Portal'));
});

test('a soft rule never reaches the prompt — hard rules must stay unambiguous', () => {
  const md = actorAgentMd(wf, triageBot);
  assert.ok(!md.includes('Prefer the newest address'), 'a soft STEP rule must not appear');
  assert.ok(!md.includes('Prefer a same-day turnaround'), 'a soft WORKFLOW rule must not appear');
});

test('a step-scoped workflow rule sits on its step, not in the trailing section', () => {
  const md = actorAgentMd(wf, triageBot);
  assert.ok(md.indexOf('Error < 0.1%') < md.indexOf('## Hard rules for the whole'));
});

test('an actor with no prompt still gets a usable generated head', () => {
  const noPrompt: Actor = { ...triageBot, prompt: undefined };
  const md = actorAgentMd({ ...wf, actors: [noPrompt] }, noPrompt);
  assert.ok(md.startsWith('# Triage Bot\n'), md.slice(0, 40));
  assert.match(md, /You are Triage Bot, an agent in the "Bank Submission" workflow\./);
  assert.match(md, /Triages inbound submissions\./);
  assert.match(md, /### 1\. Triage Submission/);
});

test('an actor with no steps says so — the preview is honest before assignment', () => {
  const fresh: Actor = { id: 'actor-agent-new', name: 'New Bot', category: 'Agent' };
  const md = actorAgentMd({ ...wf, actors: [...wf.actors, fresh] }, fresh);
  assert.match(md, /No steps are assigned to you in this workflow yet\./);
  assert.ok(!md.includes('### 1.'));
});

test('the AGENT.md does not depend on the dispositions — it is (workflow, actor) only', () => {
  // The editor's preview has no dispositions to offer; byte equality with the scaffold
  // output depends on this being true.
  assert.equal(actorAgentMd(wf, triageBot), actorAgentMd(parseWorkflow(WF), triageBot));
});

// ------------------------------------------------------------------ agent ids ---

test('an agent id is the actor name slugged, deterministic, and starts with a letter', () => {
  assert.equal(agentIdForActor({ name: 'Triage Bot', category: 'Agent' }), 'triage-bot');
  assert.equal(agentIdForActor({ name: '42 Bot', category: 'Agent' }), 'agent-42-bot');
  assert.equal(
    agentIdForActor({ id: 'actor-agent-x', name: '???', category: 'Agent' }),
    'actor-agent-x',
    'an unsluggable name falls back to the actor id',
  );
});

// ---------------------------------------------------------------- the grouping ---

test('defaultDisposition: an Agent step automates, every other actor stays manual', () => {
  assert.equal(defaultDisposition(wf.steps[0]), 'automate'); // Agent
  assert.equal(defaultDisposition(wf.steps[1]), 'manual'); // Human
  assert.equal(defaultDisposition(wf.steps[3]), 'manual'); // Software
});

test('one agent per Agent ACTOR: two steps of one actor fold into a single agent', () => {
  const plan = planAgents(wf);
  assert.equal(plan.actorAgents.length, 1);
  assert.equal(plan.actorAgents[0].agentId, 'triage-bot');
  assert.deepEqual(plan.actorAgents[0].steps.map((s) => s.id), ['triage', 'verify']);
  assert.equal(plan.stepAgents.length, 0);
  assert.deepEqual(plan.manualSteps.map((m) => m.stepId), ['prepare', 'submit']);
});

test('a Human-actor step set to automate still becomes its own agent', () => {
  const plan = planAgents(wf, { prepare: 'automate' });
  assert.equal(plan.stepAgents.length, 1);
  assert.equal(plan.stepAgents[0].step.id, 'prepare');
  assert.equal(plan.stepAgents[0].disposition, 'automate');
  assert.equal(plan.actorAgents.length, 1, 'the actor agent is unaffected');
  assert.deepEqual(plan.order.map((o) => o.agentId), ['triage-bot', 'prepare'], 'workflow order');
});

test('an Agent actor whose every step is manual gets no agent at all', () => {
  const plan = planAgents(wf, { triage: 'manual', verify: 'manual' });
  assert.equal(plan.actorAgents.length, 0);
  assert.equal(plan.stepAgents.length, 0);
  assert.equal(plan.manualSteps.length, 4);
});

test('one manual step does not shrink the actor’s AGENT.md — dispositions gate the agent, not its instructions', () => {
  const plan = planAgents(wf, { verify: 'manual' });
  assert.equal(plan.actorAgents.length, 1);
  assert.deepEqual(plan.actorAgents[0].steps.map((s) => s.id), ['triage', 'verify']);
});

const ORPHAN = `---
id: orphan
title: Orphan
domain: sales
visibility: Personal
status: draft
version: "1"
actors: []
---

\`\`\`step
id: check
title: Check It
actor: Agent
actor_name: Ghost Bot
\`\`\`

\`\`\`step
id: nameless
title: Nameless Agent Step
actor: Agent
\`\`\`
`;

test('an Agent step whose actor is not in the registry still becomes a step agent', () => {
  // `actorWarnings()` reports the defect; the scaffold must not silently lose the step.
  const plan = planAgents(parseWorkflow(ORPHAN));
  assert.equal(plan.actorAgents.length, 0);
  assert.deepEqual(plan.stepAgents.map((s) => s.step.id), ['check', 'nameless']);
});

const COLLIDE = `---
id: collide
title: Collide
domain: sales
visibility: Personal
status: draft
version: "1"
actors:
  - {id: actor-agent-prepare, name: Prepare, category: Agent}
---

\`\`\`step
id: prepare
title: Prepare Documents
actor: Human
actor_name: Officer
\`\`\`

\`\`\`step
id: act
title: Act
actor: Agent
actor_name: Prepare
\`\`\`
`;

test('an actor-derived agent id never collides with a step-derived one', () => {
  const plan = planAgents(parseWorkflow(COLLIDE), { prepare: 'automate' });
  const ids = [...plan.stepAgents.map((s) => s.agentId), ...plan.actorAgents.map((a) => a.agentId)];
  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(', ')}`);
  assert.ok(ids.includes('prepare'));
});
