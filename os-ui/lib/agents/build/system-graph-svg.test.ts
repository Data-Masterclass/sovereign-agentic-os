/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
import { renderSystemGraphSvg } from './system-graph-svg.ts';

const SYS = parseSystem(`
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: supervisor
grants: { tools: [query_data] }
agents:
  - { id: supervisor, role: Routes work, agent_md: "", memory_md: "", shortName: Boss, members: [worker] }
  - { id: worker, role: Does the work, agent_md: "", memory_md: "" }
edges:
  - { from: supervisor, to: worker, type: supervise }
`);

test('renderSystemGraphSvg emits a self-contained SVG with node labels + edges', () => {
  const { svg, width, height } = renderSystemGraphSvg(SYS, {
    labelOf: (id) => (id === 'supervisor' ? 'Boss' : id),
  });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(width > 0 && height > 0);
  // The display (short) name shows, not the raw id.
  assert.ok(svg.includes('>Boss<'), 'short name rendered');
  assert.ok(svg.includes('START'), 'entrypoint badge');
  // A supervise edge is drawn (a <line> with a marker).
  assert.ok(svg.includes('<line'), 'edge line present');
  // Deterministic — same input, identical output.
  assert.equal(renderSystemGraphSvg(SYS, { labelOf: (id) => (id === 'supervisor' ? 'Boss' : id) }).svg, svg);
});

test('renderSystemGraphSvg tolerates an empty system', () => {
  const empty = parseSystem('system: { name: X, domain: d, visibility: Personal }\nentrypoint: ""\ngrants: {}\nagents: []');
  const { svg } = renderSystemGraphSvg(empty);
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
});
