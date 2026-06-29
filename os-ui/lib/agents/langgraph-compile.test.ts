/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from './system-schema.ts';
import { compile } from './langgraph-compile.ts';

const SUP = `
entrypoint: supervisor
grants:
  tools: [metrics, retrieve, write_file]
agents:
  - id: supervisor
    role: router
    agent_md: "# Supervisor"
    memory_md: "# Mem"
    members: [worker]
  - id: worker
    role: specialist
    agent_md: "# Worker"
    memory_md: ""
    tools: [retrieve]
    model: ministral-3
edges:
  - { from: supervisor, to: worker, type: supervise }
`;

test('compiles a supervisor + worker to the expected IR', () => {
  const ir = compile(parseSystem(SUP));
  assert.deepEqual(ir.startEdge, { from: 'START', to: 'supervisor' });
  assert.deepEqual(ir.nodes.map((n) => n.id).sort(), ['supervisor', 'worker']);

  const sup = ir.nodes.find((n) => n.id === 'supervisor')!;
  assert.equal(sup.supervisor, true);
  // a supervisor with no explicit tools inherits all system grants
  assert.deepEqual(sup.tools, ['metrics', 'retrieve', 'write_file']);
  assert.equal(sup.model, null);

  const worker = ir.nodes.find((n) => n.id === 'worker')!;
  assert.equal(worker.supervisor, false);
  assert.deepEqual(worker.tools, ['retrieve']); // narrowed
  assert.equal(worker.model, 'ministral-3');

  // router: members ∪ END
  assert.deepEqual(ir.conditionalEdges, [{ source: 'supervisor', targets: ['worker', 'END'] }]);
  // supervise → member edge back to the supervisor
  assert.deepEqual(ir.memberEdges, [{ from: 'worker', to: 'supervisor' }]);
});

test('handoff edge compiles to a guarded Command(goto)', () => {
  const ir = compile(
    parseSystem(`
entrypoint: a
grants: { tools: [retrieve] }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "" }
  - { id: b, role: r, agent_md: "", memory_md: "" }
edges:
  - { from: a, to: b, type: handoff, when: "done" }
`),
  );
  assert.deepEqual(ir.commands, [{ from: 'a', to: 'b', when: 'done' }]);
});

test('rejects a missing entrypoint', () => {
  assert.throws(
    () => compile(parseSystem(`agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]`)),
    /'entrypoint' is required/,
  );
});

test('rejects an entrypoint that is not a declared agent', () => {
  assert.throws(
    () => compile(parseSystem(`entrypoint: ghost\nagents: [{ id: a, role: r, agent_md: "", memory_md: "" }]`)),
    /entrypoint 'ghost' is not a declared agent/,
  );
});

test('rejects a dangling edge (unknown agent id)', () => {
  assert.throws(
    () =>
      compile(
        parseSystem(`
entrypoint: a
agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]
edges: [{ from: a, to: ghost, type: handoff }]
`),
      ),
    /edge 'a' -> 'ghost' references unknown agent 'ghost'/,
  );
});

test('rejects an over-broad agent tool (narrow-only)', () => {
  assert.throws(
    () =>
      compile(
        parseSystem(`
entrypoint: a
grants: { tools: [retrieve] }
agents:
  - { id: a, role: r, agent_md: "", memory_md: "", tools: [retrieve, connection_crm_write] }
`),
      ),
    /agent 'a' requests tool 'connection_crm_write' not granted to the system \(narrow-only\)/,
  );
});

test('rejects a supervisor referencing an unknown member', () => {
  assert.throws(
    () =>
      compile(
        parseSystem(`
entrypoint: a
agents:
  - { id: a, role: r, agent_md: "", memory_md: "", members: [ghost] }
`),
      ),
    /agent 'a' supervises unknown member 'ghost'/,
  );
});
