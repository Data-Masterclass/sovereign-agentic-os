/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_TEMPLATES, agentTemplate, isAgentTemplateKey, type AgentTemplateKey,
} from './agent-templates.ts';
import { parseSystem, serializeSystem } from './system-schema.ts';
import { addSimpleAgent, addAgentTool } from './simple-edit.ts';
import { instructionsOf } from './agent-md.ts';

test('AGENT_TEMPLATES lists blank first plus the four curated roles', () => {
  const keys = AGENT_TEMPLATES.map((t) => t.key);
  assert.equal(keys[0], 'blank');
  for (const k of ['analyst', 'recommender', 'reviewer', 'researcher'] as AgentTemplateKey[]) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
  // Every card has a label + a plain-language blurb.
  for (const t of AGENT_TEMPLATES) { assert.ok(t.label.length > 0); assert.ok(t.blurb.length > 0); }
});

test('isAgentTemplateKey accepts known keys and rejects junk', () => {
  assert.ok(isAgentTemplateKey('researcher'));
  assert.ok(isAgentTemplateKey('blank'));
  assert.equal(isAgentTemplateKey('nope'), false);
  assert.equal(isAgentTemplateKey(42), false);
  assert.equal(isAgentTemplateKey(undefined), false);
});

test('agentTemplate returns role + non-empty instructions for every key', () => {
  for (const t of AGENT_TEMPLATES) {
    const tpl = agentTemplate(t.key);
    assert.ok(tpl.role.length > 0, `${t.key} role`);
    assert.ok(tpl.instructions.trim().length > 0, `${t.key} instructions`);
  }
});

test('researcher is a new template with grounding tools suggested', () => {
  const r = agentTemplate('researcher');
  assert.match(r.role.toLowerCase(), /research/);
  assert.deepEqual(r.suggestedTools, ['search_knowledge', 'query_data']);
});

test('an unknown key falls back to blank (no throw)', () => {
  const t = agentTemplate('bogus' as AgentTemplateKey);
  assert.equal(t.role, agentTemplate('blank').role);
});

test('template feeds addSimpleAgent + addAgentTool into a real system.yaml edit', () => {
  const base = parseSystem(`
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: assistant
grants: { tools: [search_knowledge] }
agents:
  - { id: assistant, role: A helpful assistant, agent_md: "# assistant\\n\\nHi.", memory_md: "" }
`);
  const tpl = agentTemplate('analyst');
  // Add via the SAME Simple-mode mutator the picker uses.
  let sys = addSimpleAgent(base, { role: tpl.role, instructions: tpl.instructions });
  const added = sys.agents[sys.agents.length - 1];
  assert.equal(added.role, tpl.role);
  assert.equal(instructionsOf(added.agent_md), tpl.instructions);
  // Apply suggested tools via the SAME per-agent tool mutator.
  for (const t of tpl.suggestedTools ?? []) sys = addAgentTool(sys, added.id, t);
  const after = sys.agents.find((a) => a.id === added.id)!;
  assert.ok((after.tools ?? []).includes('query_data'));
  // The result is a valid, serializable system.yaml (no parallel model).
  assert.doesNotThrow(() => serializeSystem(sys));
});
