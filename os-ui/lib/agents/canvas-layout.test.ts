/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from './system-schema.ts';
import { layoutSystem } from './canvas-layout.ts';

const SYS = `
entrypoint: supervisor
grants: { tools: [retrieve, write_file] }
agents:
  - { id: supervisor, role: router, agent_md: "", memory_md: "", members: [researcher, writer] }
  - { id: researcher, role: finds, agent_md: "", memory_md: "", tools: [retrieve] }
  - { id: writer, role: writes, agent_md: "", memory_md: "", tools: [write_file] }
edges:
  - { from: supervisor, to: researcher, type: supervise }
  - { from: supervisor, to: writer, type: supervise }
  - { from: researcher, to: writer, type: handoff, when: done }
`;

test('lays out one block per agent with the entrypoint marked', () => {
  const lay = layoutSystem(parseSystem(SYS));
  assert.equal(lay.blocks.length, 3);
  const entry = lay.blocks.find((b) => b.id === 'supervisor')!;
  assert.equal(entry.entrypoint, true);
  assert.equal(entry.supervisor, true);
  // every block has a finite position + size
  for (const b of lay.blocks) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
    assert.ok(b.w > 0 && b.h > 0);
  }
  // the canvas is sized to contain every block
  for (const b of lay.blocks) {
    assert.ok(b.x + b.w <= lay.width);
    assert.ok(b.y + b.h <= lay.height);
  }
});

test('every edge connects two real blocks and keeps its kind', () => {
  const lay = layoutSystem(parseSystem(SYS));
  assert.equal(lay.edges.length, 3);
  const ids = new Set(lay.blocks.map((b) => b.id));
  for (const e of lay.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to));
    assert.ok(e.type === 'supervise' || e.type === 'handoff');
    assert.ok(Number.isFinite(e.x1) && Number.isFinite(e.y1) && Number.isFinite(e.x2) && Number.isFinite(e.y2));
  }
  assert.ok(lay.edges.some((e) => e.type === 'handoff' && e.from === 'researcher' && e.to === 'writer'));
});

test('draws a supervise route for a member with no explicit edge (helper-added)', () => {
  // supervisor supervises [researcher] but only researcher has an explicit edge;
  // a helper that added `writer` to members without an edge must still be drawn.
  const sys = `
entrypoint: supervisor
grants: { tools: [retrieve] }
agents:
  - { id: supervisor, role: router, agent_md: "", memory_md: "", members: [researcher, writer] }
  - { id: researcher, role: finds, agent_md: "", memory_md: "" }
  - { id: writer, role: writes, agent_md: "", memory_md: "" }
edges:
  - { from: supervisor, to: researcher, type: supervise }
`;
  const lay = layoutSystem(parseSystem(sys));
  const sup = lay.edges.filter((e) => e.type === 'supervise' && e.from === 'supervisor');
  assert.deepEqual(sup.map((e) => e.to).sort(), ['researcher', 'writer']);
  // No duplicate for the member that already had an explicit edge.
  assert.equal(sup.filter((e) => e.to === 'researcher').length, 1);
});

test('a disabled sub-agent is flagged for the canvas', () => {
  const lay = layoutSystem(parseSystem(SYS), { disabledAgents: ['writer'] });
  assert.equal(lay.blocks.find((b) => b.id === 'writer')!.disabled, true);
  assert.equal(lay.blocks.find((b) => b.id === 'researcher')!.disabled, false);
});
