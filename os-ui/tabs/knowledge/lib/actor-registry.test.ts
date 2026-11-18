/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The workflow actor registry — deletion that sticks, renames that travel
 * USER STORY: As a process owner I must be able to delete an actor and rename one and have the
 *             workflow agree with me afterwards, instead of the actor reappearing on the next load.
 * ARCHITECTURE:
 *   - The `actors:` frontmatter key IS the registry once present (even when empty); derivation from
 *     the steps happens only for a legacy file that has no `actors:` section at all.
 *   - A step naming an actor the registry does not hold is a VALIDATION WARNING, never a
 *     resurrected registry entry — that distinction is what these tests pin.
 *   - Pure module tests: parse / serialize / step-edit / actor-registry only, no IO.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow, serializeWorkflow } from '@tabs/knowledge/lib/schema';
import { removeActor, updateActor } from '@tabs/knowledge/lib/step-edit';
import { actorWarnings, stepsUsingActor } from '@tabs/knowledge/lib/actor-registry';

const WITH_REGISTRY = `---
id: wf
title: WF
domain: sales
visibility: Personal
status: draft
version: "1"
actors:
  - id: a-officer
    name: Loan Officer
    category: Human
    description: Approves deals over EUR 50k.
  - id: a-portal
    name: BankPortal
    category: Software
---

\`\`\`step
id: prepare
title: Prepare documents
actor: Human
actor_name: Loan Officer
\`\`\`

\`\`\`step
id: submit
title: Submit to the bank
actor: Software
actor_name: BankPortal
\`\`\`
`;

/** A pre-registry workflow.md — no `actors:` section at all. */
const LEGACY_NO_REGISTRY = `---
id: wf
title: WF
domain: sales
visibility: Personal
status: draft
version: "1"
---

\`\`\`step
id: prepare
title: Prepare documents
actor: Human
actor_name: Loan Officer
\`\`\`

\`\`\`step
id: submit
title: Submit to the bank
actor: Software
actor_name: BankPortal
\`\`\`
`;

/** A registry that deliberately omits an actor a step still names. */
const REGISTRY_MISSING_ONE = `---
id: wf
title: WF
domain: sales
visibility: Personal
status: draft
version: "1"
actors:
  - id: a-officer
    name: Loan Officer
    category: Human
---

\`\`\`step
id: prepare
title: Prepare documents
actor: Human
actor_name: Loan Officer
\`\`\`

\`\`\`step
id: submit
title: Submit to the bank
actor: Software
actor_name: BankPortal
\`\`\`
`;

// --- the registry is the source of truth -------------------------------------

test('an actor removed from the registry stays gone after a re-parse (no resurrection)', () => {
  const w1 = removeActor(parseWorkflow(WITH_REGISTRY), 'a-officer'); // step `prepare` still names it
  const again = parseWorkflow(serializeWorkflow(w1));
  assert.equal(again.actors.find((a) => a.name === 'Loan Officer'), undefined);
  assert.deepEqual(
    actorWarnings(again).map((x) => [x.stepId, x.actorName]),
    [['prepare', 'Loan Officer']],
  );
});

test('removing the LAST registry actor survives the round trip (an empty actors: is written)', () => {
  let w = parseWorkflow(WITH_REGISTRY);
  for (const a of [...w.actors]) w = removeActor(w, a.id!);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.deepEqual(again.actors, []);
  assert.equal(actorWarnings(again).length, 2);
});

test('a legacy workflow with no actors: section derives a registry, each with a stable id', () => {
  const w = parseWorkflow(LEGACY_NO_REGISTRY);
  assert.equal(w.actors.length, 2);
  assert.ok(w.actors.every((a) => !!a.id), 'every derived actor carries an id');
  const again = parseWorkflow(serializeWorkflow(w));
  assert.deepEqual(again.actors.map((a) => a.id), w.actors.map((a) => a.id));
  assert.equal(actorWarnings(again).length, 0);
});

test('with an actors: section the registry is NOT re-derived from the steps', () => {
  const w = parseWorkflow(REGISTRY_MISSING_ONE);
  assert.deepEqual(w.actors.map((a) => a.name), ['Loan Officer']);
  assert.deepEqual(actorWarnings(w).map((x) => x.actorName), ['BankPortal']);
});

// --- rename travels, delete asks ---------------------------------------------

test('renaming a registry actor rewrites every referencing step in the same mutation', () => {
  const w = updateActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { name: 'Senior Loan Officer' });
  assert.equal(w.steps[0].actor_name, 'Senior Loan Officer');
  assert.equal(actorWarnings(w).length, 0);
  const again = parseWorkflow(serializeWorkflow(w));
  assert.equal(again.steps[0].actor_name, 'Senior Loan Officer');
  assert.ok(again.actors.find((a) => a.name === 'Senior Loan Officer'));
});

test('changing a registry actor category moves its steps to the new category', () => {
  const w = updateActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { category: 'Agent' });
  assert.equal(w.steps[0].actor, 'Agent');
  assert.equal(actorWarnings(w).length, 0);
});

test('removeActor with reassignTo moves every referencing step to the other actor', () => {
  const w = removeActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { reassignTo: 'a-portal' });
  assert.equal(w.actors.length, 1);
  assert.equal(w.steps[0].actor, 'Software');
  assert.equal(w.steps[0].actor_name, 'BankPortal');
  assert.equal(actorWarnings(w).length, 0);
});

test('removeActor with clearSteps leaves no dangling name and no warning', () => {
  const w = removeActor(parseWorkflow(WITH_REGISTRY), 'a-officer', { clearSteps: true });
  assert.equal(w.steps[0].actor_name, '');
  assert.equal(actorWarnings(w).length, 0);
});

test('removeActor is immutable and unknown ids are a no-op', () => {
  const w0 = parseWorkflow(WITH_REGISTRY);
  const w = removeActor(w0, 'nope');
  assert.equal(w0.actors.length, 2);
  assert.equal(w.actors.length, 2);
});

test('stepsUsingActor lists the steps an actor is used by', () => {
  const w = parseWorkflow(WITH_REGISTRY);
  assert.deepEqual(stepsUsingActor(w, w.actors[0]).map((s) => s.id), ['prepare']);
  assert.deepEqual(stepsUsingActor(w, w.actors[1]).map((s) => s.id), ['submit']);
});
