/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem } from './system-schema.ts';
import { compile } from './langgraph-compile.ts';
import {
  addAgent,
  addHandoffEdge,
  addSuperviseEdge,
  removeAgent,
  removeEdge,
  setAgentModel,
  setAgentTools,
  setEntrypoint,
  setNodePositions,
} from './canvas-edit.ts';
import { MODEL_MODES, modeForModel } from './routing.ts';

function base() {
  return parseSystem(
    [
      'version: "1"',
      'system: { name: T, domain: sales, visibility: Personal }',
      'entrypoint: supervisor',
      'grants: { data: [], knowledge: [], tools: [retrieve, write_file], connections: [] }',
      'agents:',
      '  - { id: supervisor, role: routes, agent_md: "# s", memory_md: "", members: [researcher] }',
      '  - { id: researcher, role: finds, agent_md: "# r", memory_md: "", tools: [retrieve] }',
      'edges:',
      '  - { from: supervisor, to: researcher, type: supervise }',
    ].join('\n'),
  );
}

test('addAgent appends a narrowed ReAct agent and the system still compiles', () => {
  const sys = addAgent(base(), { id: 'writer', role: 'drafts' });
  assert.ok(sys.agents.some((a) => a.id === 'writer'));
  const w = sys.agents.find((a) => a.id === 'writer')!;
  assert.equal(w.agent_md.includes('writer'), true);
  // A fresh agent inherits (no narrowing) — undefined tools, never broader.
  assert.equal(w.tools, undefined);
  // WP1 papercut: a new agent gets a friendly MEMORY.md starter, not '' (which
  // loaded as a bare empty editor and read as "nothing here").
  assert.ok(w.memory_md.length > 0, 'new agent has a non-empty MEMORY.md starter');
  assert.match(w.memory_md, /Memory/);
  assert.doesNotThrow(() => compile(sys));
});

test('addAgent rejects a duplicate id', () => {
  assert.throws(() => addAgent(base(), { id: 'researcher', role: 'x' }), /already exists/);
});

test('addAgent rejects an empty / invalid id', () => {
  assert.throws(() => addAgent(base(), { id: '', role: 'x' }), /id/);
});

test('addSuperviseEdge adds the member to the supervisor AND a return edge; compiles', () => {
  let sys = addAgent(base(), { id: 'writer', role: 'drafts' });
  sys = addSuperviseEdge(sys, 'supervisor', 'writer');
  const sup = sys.agents.find((a) => a.id === 'supervisor')!;
  assert.deepEqual(sup.members, ['researcher', 'writer']);
  assert.ok(sys.edges.some((e) => e.from === 'supervisor' && e.to === 'writer' && e.type === 'supervise'));
  const ir = compile(sys);
  // The router fans out to its members ∪ END.
  const cond = ir.conditionalEdges.find((c) => c.source === 'supervisor')!;
  assert.deepEqual(cond.targets.sort(), ['END', 'researcher', 'writer'].sort());
});

test('addHandoffEdge wires a guarded Command between two agents; compiles', () => {
  let sys = addAgent(base(), { id: 'writer', role: 'drafts' });
  sys = addHandoffEdge(sys, 'researcher', 'writer', 'research done');
  const ir = compile(sys);
  const cmd = ir.commands.find((c) => c.from === 'researcher' && c.to === 'writer')!;
  assert.equal(cmd.when, 'research done');
});

test('edge helpers reject unknown / self endpoints', () => {
  assert.throws(() => addHandoffEdge(base(), 'researcher', 'ghost'), /unknown/);
  assert.throws(() => addHandoffEdge(base(), 'researcher', 'researcher'), /itself/);
  assert.throws(() => addSuperviseEdge(base(), 'nope', 'researcher'), /unknown/);
});

test('edge helpers reject a duplicate edge', () => {
  // base() already has supervisor --supervise--> researcher.
  assert.throws(() => addSuperviseEdge(base(), 'supervisor', 'researcher'), /already supervises/);
  const handed = addHandoffEdge(base(), 'researcher', 'supervisor');
  assert.throws(() => addHandoffEdge(handed, 'researcher', 'supervisor'), /already hands off/);
});

test('removeEdge drops the edge and (for supervise) the membership', () => {
  const sys = removeEdge(base(), { from: 'supervisor', to: 'researcher', type: 'supervise' });
  assert.equal(sys.edges.length, 0);
  const sup = sys.agents.find((a) => a.id === 'supervisor')!;
  assert.deepEqual(sup.members, []);
});

test('removeAgent removes the agent, its edges and membership refs', () => {
  const sys = removeAgent(base(), 'researcher');
  assert.equal(sys.agents.some((a) => a.id === 'researcher'), false);
  assert.equal(sys.edges.length, 0);
  const sup = sys.agents.find((a) => a.id === 'supervisor')!;
  assert.deepEqual(sup.members ?? [], []);
});

test('removeAgent refuses to remove the entrypoint', () => {
  assert.throws(() => removeAgent(base(), 'supervisor'), /entrypoint/);
});

test('setEntrypoint must reference a declared agent', () => {
  const sys = setEntrypoint(base(), 'researcher');
  assert.equal(sys.entrypoint, 'researcher');
  assert.throws(() => setEntrypoint(base(), 'ghost'), /not a declared agent/);
});

test('setAgentTools narrows to a subset and clears when it equals the grants', () => {
  const narrowed = setAgentTools(base(), 'supervisor', ['retrieve']);
  const sup = narrowed.agents.find((a) => a.id === 'supervisor')!;
  assert.deepEqual(sup.tools, ['retrieve']);
  // Selecting every granted tool === inherit (no narrowing recorded).
  const full = setAgentTools(base(), 'supervisor', ['retrieve', 'write_file']);
  assert.equal(full.agents.find((a) => a.id === 'supervisor')!.tools, undefined);
});

test('setAgentTools rejects a tool not granted to the system (narrow-only)', () => {
  assert.throws(() => setAgentTools(base(), 'supervisor', ['delete_everything']), /not granted/);
});

test('setAgentModel sets and clears the per-agent override', () => {
  const set = setAgentModel(base(), 'researcher', 'stackit-qwen3-vl-reasoning');
  assert.equal(set.agents.find((a) => a.id === 'researcher')!.model, 'stackit-qwen3-vl-reasoning');
  const cleared = setAgentModel(set, 'researcher', '');
  assert.equal(cleared.agents.find((a) => a.id === 'researcher')!.model, undefined);
});

test('the Auto/Reasoning/Execution toggle writes the right pin (and Auto clears it) round-trip', () => {
  // The AgentEditor toggle calls setAgentModel(sys, id, mode.model ?? '') and then
  // modeForModel reads the pin back to light up the active segment. Prove the loop.
  for (const m of MODEL_MODES) {
    const next = setAgentModel(base(), 'researcher', m.model ?? '');
    const pinned = next.agents.find((a) => a.id === 'researcher')!.model;
    if (m.mode === 'auto') assert.equal(pinned, undefined, 'Auto clears the pin');
    else assert.equal(pinned, m.model, `${m.mode} pins ${m.model}`);
    assert.equal(modeForModel(pinned ?? null), m.mode, `${m.mode} reads back to itself`);
  }
});

test('setNodePositions saves rounded positions, merges, and prunes removed agents', () => {
  let sys = setNodePositions(base(), { supervisor: { x: 12.6, y: 40.2 } });
  assert.deepEqual(sys.ui?.positions?.supervisor, { x: 13, y: 40 }); // rounded
  // merge: a second call keeps the first and adds the new one.
  sys = setNodePositions(sys, { researcher: { x: 100, y: 200 } });
  assert.deepEqual(Object.keys(sys.ui!.positions!).sort(), ['researcher', 'supervisor']);
  // removing an agent then re-saving prunes its stale position.
  sys = removeAgent(sys, 'researcher');
  sys = setNodePositions(sys, {});
  assert.equal(sys.ui?.positions?.researcher, undefined);
  assert.deepEqual(sys.ui?.positions, { supervisor: { x: 13, y: 40 } });
});

test('mutations round-trip cleanly through serialize -> parse', () => {
  let sys = addAgent(base(), { id: 'writer', role: 'drafts' });
  sys = addSuperviseEdge(sys, 'supervisor', 'writer');
  sys = addHandoffEdge(sys, 'researcher', 'writer', 'done');
  const round = parseSystem(serializeSystem(sys));
  assert.deepEqual(round.edges, sys.edges);
  assert.equal(round.agents.length, sys.agents.length);
});

test('mutations never touch the input (pure / immutable)', () => {
  const input = base();
  const before = serializeSystem(input);
  addAgent(input, { id: 'writer', role: 'x' });
  addHandoffEdge(input, 'researcher', 'supervisor');
  removeEdge(input, { from: 'supervisor', to: 'researcher', type: 'supervise' });
  assert.equal(serializeSystem(input), before);
});
