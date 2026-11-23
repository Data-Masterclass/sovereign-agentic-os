/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `model: strong | standard | auto` per agent — schema, legacy reading, the one model it means
 * USER STORY: As a builder I pick Strong, Standard or Auto per agent; a system made before the field runs on Strong.
 * ARCHITECTURE: pure tests over `agent-model.ts`, `system-schema.ts` and `langgraph-compile.ts`; twins for each rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentModelRole, agentModelTier, agentModelReason, agentModelShort, normalizeModelChoice } from '@tabs/agents/lib/agent-model';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { setAgentModel, addAgent } from '@tabs/agents/lib/canvas-edit';

const yamlWith = (agentExtra: string) => `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: a
grants:
  tools: [search_knowledge]
agents:
  - { id: a, role: reads, agent_md: "# A", memory_md: ""${agentExtra} }
`;

test('LEGACY: a system without the field runs on Strong (no behaviour change)', () => {
  const sys = parseSystem(yamlWith(''));
  assert.equal(sys.agents[0].model, undefined);
  assert.equal(agentModelTier(sys.agents[0]), 'strong');
  assert.equal(agentModelRole(sys.agents[0]), 'sovereign-strong');
  assert.equal(compile(sys).nodes[0].model, null, 'the IR keeps "not set" (the Team panel routes it as before)');
});

test('the three choices parse, round-trip and compile to the gateway role', () => {
  for (const [choice, role] of [['strong', 'sovereign-strong'], ['standard', 'sovereign-worker']] as const) {
    const sys = parseSystem(yamlWith(`, model: ${choice}`));
    assert.equal(sys.agents[0].model, choice);
    assert.equal(agentModelRole(sys.agents[0]), role);
    assert.equal(compile(sys).nodes[0].model, role);
    assert.equal(parseSystem(serializeSystem(sys)).agents[0].model, choice);
  }
});

test('auto: resolved → that tier, with its reason kept; unresolved → Strong', () => {
  const resolved = parseSystem(yamlWith(', model: auto, model_resolved: standard, model_reason: "reads and summarises"'));
  assert.equal(agentModelTier(resolved.agents[0]), 'standard');
  assert.equal(resolved.agents[0].model_reason, 'reads and summarises');
  assert.match(agentModelReason(resolved.agents[0]), /Auto chose Standard: reads and summarises/);
  assert.equal(agentModelShort(resolved.agents[0]), 'Auto: Standard');
  const round = parseSystem(serializeSystem(resolved)).agents[0];
  assert.deepEqual([round.model, round.model_resolved, round.model_reason], ['auto', 'standard', 'reads and summarises']);
  const open = parseSystem(yamlWith(', model: auto'));
  assert.equal(agentModelTier(open.agents[0]), 'strong');
  assert.equal(agentModelShort(open.agents[0]), 'Auto');
});

test('TWIN: a resolution without `auto` is dropped (an explicit choice always wins)', () => {
  const sys = parseSystem(yamlWith(', model: strong, model_resolved: standard, model_reason: x'));
  assert.equal(sys.agents[0].model_resolved, undefined);
  assert.equal(sys.agents[0].model_reason, undefined);
  assert.equal(agentModelTier(sys.agents[0]), 'strong');
});

test('older stored values read as the tier they stand for; anything else is Strong', () => {
  assert.equal(normalizeModelChoice('sovereign-strong'), 'strong');
  assert.equal(normalizeModelChoice('sovereign-worker'), 'standard');
  assert.equal(normalizeModelChoice('sovereign-default'), 'standard');
  assert.equal(normalizeModelChoice('sovereign-reasoning'), 'strong');
  assert.equal(normalizeModelChoice('Auto'), 'auto');
  assert.equal(normalizeModelChoice('some-catalog-model'), 'strong');
  assert.equal(normalizeModelChoice(''), undefined);
  assert.equal(normalizeModelChoice(null), undefined);
});

test('the builder: a new agent starts on Auto; choosing a model clears an old Auto decision', () => {
  const base = parseSystem(yamlWith(', model: auto, model_resolved: standard, model_reason: r'));
  const added = addAgent(base, { id: 'b', role: 'writes' });
  assert.equal(added.agents.find((a) => a.id === 'b')!.model, 'auto');
  const strong = setAgentModel(base, 'a', 'strong').agents[0];
  assert.deepEqual([strong.model, strong.model_resolved, strong.model_reason], ['strong', undefined, undefined]);
  const backToAuto = setAgentModel(base, 'a', 'auto').agents[0];
  assert.equal(backToAuto.model_resolved, undefined, 'the next Build decides afresh');
});
