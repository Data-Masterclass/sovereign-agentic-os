/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from './system-schema.ts';
import { nodesFromSystem, edgesFromSystem, canConnect, edgeId } from './flow-adapter.ts';

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
      '  - { id: writer, role: drafts, agent_md: "# w", memory_md: "" }',
      'edges:',
      '  - { from: supervisor, to: researcher, type: supervise }',
    ].join('\n'),
  );
}

test('nodesFromSystem: one node per agent with entrypoint/supervisor/tool metadata', () => {
  const nodes = nodesFromSystem(base());
  assert.equal(nodes.length, 3);
  const sup = nodes.find((n) => n.id === 'supervisor')!;
  assert.equal(sup.data.entrypoint, true);
  assert.equal(sup.data.supervisor, true);
  const writer = nodes.find((n) => n.id === 'writer')!;
  assert.equal(writer.data.entrypoint, false);
  // writer inherits the 2 system tool grants (no narrowing)
  assert.equal(writer.data.tools, 2);
  // researcher is narrowed to 1
  assert.equal(nodes.find((n) => n.id === 'researcher')!.data.tools, 1);
});

test('nodesFromSystem: saved ui.positions win over the fallback grid layout', () => {
  const sys = parseSystem(
    [
      'version: "1"',
      'system: { name: T, domain: sales, visibility: Personal }',
      'entrypoint: a',
      'grants: { data: [], knowledge: [], tools: [], connections: [] }',
      'agents: [{ id: a, role: r, agent_md: "", memory_md: "" }]',
      'ui: { positions: { a: { x: 321, y: 654 } } }',
    ].join('\n'),
  );
  assert.deepEqual(nodesFromSystem(sys)[0].position, { x: 321, y: 654 });
});

test('nodesFromSystem: missing positions fall back to the deterministic grid (never 0,0 collapse)', () => {
  const nodes = nodesFromSystem(base());
  // three agents ⇒ at least two distinct positions (no all-zero pileup)
  const uniq = new Set(nodes.map((n) => `${n.position.x},${n.position.y}`));
  assert.ok(uniq.size >= 2, 'fallback layout spreads nodes out');
});

test('edgesFromSystem: explicit edges + derived member→supervise routes, deduped', () => {
  const edges = edgesFromSystem(base());
  // supervisor→researcher appears once even though it is BOTH an explicit edge and
  // a membership-derived route.
  const supRes = edges.filter((e) => e.source === 'supervisor' && e.target === 'researcher');
  assert.equal(supRes.length, 1);
  assert.equal(supRes[0].type, 'supervise');
  assert.equal(supRes[0].id, edgeId('supervisor', 'researcher', 'supervise'));
});

test('edgesFromSystem: a handoff carries its when label; a dangling edge is skipped', () => {
  const sys = parseSystem(
    [
      'version: "1"',
      'system: { name: T, domain: sales, visibility: Personal }',
      'entrypoint: a',
      'grants: { data: [], knowledge: [], tools: [], connections: [] }',
      'agents:',
      '  - { id: a, role: r, agent_md: "", memory_md: "" }',
      '  - { id: b, role: r, agent_md: "", memory_md: "" }',
      'edges:',
      '  - { from: a, to: b, type: handoff, when: "done" }',
      '  - { from: a, to: ghost, type: handoff }',
    ].join('\n'),
  );
  const edges = edgesFromSystem(sys);
  assert.equal(edges.length, 1); // ghost target skipped
  assert.equal(edges[0].label, 'done');
  assert.equal(edges[0].data.when, 'done');
});

test('canConnect mirrors the canvas-edit guards (self / duplicate / unknown)', () => {
  const sys = base();
  assert.equal(canConnect(sys, 'supervisor', 'supervisor').ok, false); // self
  assert.equal(canConnect(sys, 'supervisor', 'researcher').ok, false); // already supervises
  assert.equal(canConnect(sys, 'supervisor', 'writer').ok, true); // new supervise
  assert.equal(canConnect(sys, 'researcher', 'ghost').ok, false); // unknown target
  // researcher is not a supervisor → a new connection is a handoff, allowed once
  assert.equal(canConnect(sys, 'researcher', 'writer').ok, true);
});
