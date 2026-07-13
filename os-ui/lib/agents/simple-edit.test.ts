/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem } from './system-schema.ts';
import {
  setAgentRole, setAgentInstructions, setSystemTools, addSystemTool, removeSystemTool,
  addSimpleAgent, moveAgent, nextAgentId, addArtifactGrant, removeArtifactGrant,
} from './simple-edit.ts';
import { instructionsOf } from './agent-md.ts';

const BASE = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: analyst
grants: { tools: [search_knowledge, query_data] }
agents:
  - { id: analyst, role: Analyzes sources, agent_md: "# analyst\\n\\nOld instructions.", memory_md: "" }
  - { id: writer, role: Writes it up, agent_md: "# writer\\n\\nWrites.", memory_md: "" }
`;

test('setAgentInstructions writes the SAME agent_md a Developer AGENT.md edit would', () => {
  const sys = parseSystem(BASE);
  // Simple mode: the textarea shows only the body...
  assert.equal(instructionsOf(sys.agents[0].agent_md), 'Old instructions.');
  const next = setAgentInstructions(sys, 'analyst', 'Fresh instructions.');
  // ...and writing back keeps the heading — i.e. the exact file Developer mode holds.
  assert.equal(next.agents[0].agent_md, '# analyst\n\nFresh instructions.');
  // Developer mode edits agent_md directly to the same string — identical system.yaml.
  const dev = structuredClone(sys);
  dev.agents[0].agent_md = '# analyst\n\nFresh instructions.';
  assert.equal(serializeSystem(next), serializeSystem(dev), 'same system.yaml as the Developer edit');
});

test('setSystemTools writes the SAME grants.tools the Grants panel would', () => {
  const sys = parseSystem(BASE);
  const simple = setSystemTools(sys, ['search_knowledge', 'query_data', 'list_datasets']);
  // Developer Grants panel pushes onto grants.tools directly.
  const dev = structuredClone(sys);
  dev.grants.tools.push('list_datasets');
  assert.equal(serializeSystem(simple), serializeSystem(dev), 'identical system.yaml');
});

test('addSystemTool is idempotent and removeSystemTool also un-narrows agents', () => {
  let sys = parseSystem(BASE);
  sys = addSystemTool(sys, 'query_data'); // already present
  assert.deepEqual(sys.grants.tools, ['search_knowledge', 'query_data']);
  // narrow an agent, then remove the tool system-wide
  sys.agents[1].tools = ['query_data'];
  const removed = removeSystemTool(sys, 'query_data');
  assert.ok(!removed.grants.tools.includes('query_data'));
  assert.ok(!(removed.agents[1].tools ?? []).includes('query_data'), 'narrowing dropped too');
});

test('setSystemTools de-duplicates', () => {
  const sys = parseSystem(BASE);
  const out = setSystemTools(sys, ['a', 'a', 'b', 'b', 'a']);
  assert.deepEqual(out.grants.tools, ['a', 'b']);
});

test('addSimpleAgent adds a plain agent; first-ever agent becomes START', () => {
  const empty = parseSystem('system: { name: X, domain: d, visibility: Personal }\nentrypoint: ""\ngrants: {}\nagents: []');
  const one = addSimpleAgent(empty, { role: 'Greeter', instructions: 'Say hi.' });
  assert.equal(one.agents.length, 1);
  assert.equal(one.entrypoint, one.agents[0].id, 'first agent auto-becomes START');
  assert.equal(instructionsOf(one.agents[0].agent_md), 'Say hi.');
  // Adding a second does NOT steal the entrypoint.
  const two = addSimpleAgent(one, { role: 'Writer' });
  assert.equal(two.entrypoint, one.agents[0].id);
  assert.equal(two.agents.length, 2);
});

test('addSimpleAgent uses the same agentN naming as the canvas', () => {
  const sys = parseSystem(BASE);
  assert.equal(nextAgentId(sys), 'agent3');
  const next = addSimpleAgent(sys, {});
  assert.ok(next.agents.some((a) => a.id === 'agent3'));
});

test('addSimpleAgent rejects a duplicate id', () => {
  const sys = parseSystem(BASE);
  assert.throws(() => addSimpleAgent(sys, { id: 'analyst' }), /already exists/);
});

test('setAgentRole edits only the role', () => {
  const sys = parseSystem(BASE);
  const next = setAgentRole(sys, 'writer', 'Chief scribe');
  assert.equal(next.agents[1].role, 'Chief scribe');
  assert.equal(next.agents[1].agent_md, sys.agents[1].agent_md, 'instructions untouched');
});

test('moveAgent reorders and clamps at the ends', () => {
  const sys = parseSystem(BASE);
  const down = moveAgent(sys, 'analyst', 1);
  assert.deepEqual(down.agents.map((a) => a.id), ['writer', 'analyst']);
  // clamp: moving the first up is a no-op
  const up = moveAgent(sys, 'analyst', -1);
  assert.deepEqual(up.agents.map((a) => a.id), ['analyst', 'writer']);
});

test('addArtifactGrant grants Data at Read and is idempotent', () => {
  const sys = parseSystem(BASE);
  const one = addArtifactGrant(sys, 'data', 'ds_campaigns');
  assert.deepEqual(one.grants.data, [{ id: 'ds_campaigns', capability: 'Read' }]);
  // idempotent — a second add does not duplicate
  const two = addArtifactGrant(one, 'data', 'ds_campaigns');
  assert.equal(two.grants.data.length, 1);
});

test('addArtifactGrant / removeArtifactGrant round-trip on Knowledge', () => {
  const sys = parseSystem(BASE);
  const added = addArtifactGrant(sys, 'knowledge', 'wf_playbook');
  assert.deepEqual(added.grants.knowledge, [{ id: 'wf_playbook', capability: 'Read' }]);
  const removed = removeArtifactGrant(added, 'knowledge', 'wf_playbook');
  assert.deepEqual(removed.grants.knowledge, []);
  // removing a non-grant is a no-op
  assert.deepEqual(removeArtifactGrant(sys, 'data', 'nope').grants.data, sys.grants.data);
});

test('every Simple edit leaves the input untouched (immutability, for undo/redo)', () => {
  const sys = parseSystem(BASE);
  const snapshot = serializeSystem(sys);
  setAgentRole(sys, 'analyst', 'x');
  setAgentInstructions(sys, 'analyst', 'y');
  setSystemTools(sys, ['z']);
  addSimpleAgent(sys, { role: 'q' });
  moveAgent(sys, 'analyst', 1);
  assert.equal(serializeSystem(sys), snapshot, 'input never mutated');
});
