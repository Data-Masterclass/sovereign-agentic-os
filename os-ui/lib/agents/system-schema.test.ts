/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem } from './system-schema.ts';

const VALID = `
version: "1"
system:
  name: Research Desk
  domain: sales
  visibility: Personal
entrypoint: supervisor
grants:
  tools: [metrics, retrieve, write_file]
  connections:
    - id: crm
      capability: Read
agents:
  - id: supervisor
    role: Routes work to specialists
    agent_md: "# Supervisor"
    memory_md: "# Memory"
    members: [researcher]
  - id: researcher
    role: Finds facts
    agent_md: "# Researcher"
    memory_md: ""
    tools: [retrieve]
edges:
  - { from: supervisor, to: researcher, type: supervise }
`;

test('parses a valid system.yaml', () => {
  const sys = parseSystem(VALID);
  assert.equal(sys.entrypoint, 'supervisor');
  assert.equal(sys.system.name, 'Research Desk');
  assert.equal(sys.system.visibility, 'Personal');
  assert.equal(sys.agents.length, 2);
  assert.deepEqual(sys.agents[0].members, ['researcher']);
  assert.equal(sys.edges[0].type, 'supervise');
  assert.deepEqual(sys.grants.connections, [{ id: 'crm', capability: 'Read' }]);
});

test('defaults state.channels to {messages: add_messages}', () => {
  const sys = parseSystem(VALID);
  assert.deepEqual(sys.state.channels, { messages: 'add_messages' });
});

test('defaults empty grants + routing overrides', () => {
  const sys = parseSystem(`
entrypoint: a
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
`);
  assert.deepEqual(sys.grants.tools, []);
  assert.deepEqual(sys.grants.connections, []);
  assert.deepEqual(sys.routing.overrides, {});
});

test('rejects a non-mapping root', () => {
  assert.throws(() => parseSystem('- a\n- b'), /expected a mapping at the document root/);
});

test('rejects an invalid edge type with an exact error', () => {
  assert.throws(
    () =>
      parseSystem(`
entrypoint: a
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
edges: [{ from: a, to: a, type: bogus }]
`),
    /edge 'a' -> 'a' has invalid type 'bogus' \(expected supervise\|handoff\)/,
  );
});

test('round-trips through serialize -> parse', () => {
  const sys = parseSystem(VALID);
  const yaml = serializeSystem(sys);
  const again = parseSystem(yaml);
  assert.deepEqual(again.agents.map((a) => a.id), ['supervisor', 'researcher']);
  assert.equal(again.entrypoint, 'supervisor');
});

test('ui.positions round-trips and is pruned to declared agents', () => {
  const sys = parseSystem(`
entrypoint: a
grants: { tools: [], connections: [] }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
  - { id: b, role: r, agent_md: "", memory_md: "" }
ui:
  positions:
    a: { x: 10, y: 20 }
    b: { x: 30, y: 40 }
    ghost: { x: 99, y: 99 }
`);
  // ghost has no agent → pruned on parse.
  assert.deepEqual(sys.ui?.positions, { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
  // survives a serialize→parse round-trip.
  const again = parseSystem(serializeSystem(sys));
  assert.deepEqual(again.ui?.positions, { a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
});

test('no ui block is emitted when there are no positions (byte-stable legacy files)', () => {
  const sys = parseSystem(`
entrypoint: a
grants: { tools: [], connections: [] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
`);
  assert.equal(sys.ui, undefined);
  assert.ok(!/\bui:/.test(serializeSystem(sys)), 'serialized file has no ui: key');
});

test('malformed ui positions are ignored (non-numeric / non-record)', () => {
  const sys = parseSystem(`
entrypoint: a
grants: { tools: [], connections: [] }
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
ui: { positions: { a: { x: "nope", y: 5 } } }
`);
  assert.equal(sys.ui, undefined); // no valid positions → no ui block
});
