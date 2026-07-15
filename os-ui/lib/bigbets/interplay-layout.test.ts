/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The pure interplay layout (Phase 2, view layer): type-banding (anchor ▸
 * components ▸ context), honouring saved positions, edge routing to block
 * anchors, dangling-edge skip, and the empty-blueprint case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutInterplay, bandFor } from './interplay-layout.ts';
import type { ComponentRef, SolutionEdge, Tab } from './model.ts';

let seq = 0;
function ref(tab: Tab, id = `r${++seq}`): ComponentRef {
  return {
    id,
    artifactId: `art-${id}`,
    tab,
    start: '2026-01-01',
    plannedReady: '2026-02-01',
    dependsOn: [],
    weight: 0,
    origin: 'scaffolded',
    addedBy: 'sara',
    addedAt: '2026-01-01',
  };
}
function edge(from: string, to: string, relation: SolutionEdge['relation']): SolutionEdge {
  return { id: `${from}-${to}-${relation}`, from, to, relation, addedBy: 'sara', addedAt: '2026-01-01' };
}

test('bandFor: anchor id wins; leaf tabs → components; the rest → context', () => {
  const wf = ref('knowledge', 'wf');
  assert.equal(bandFor(wf, 'wf'), 'anchor', 'the anchor ref is band 0 even though knowledge is context');
  assert.equal(bandFor(wf, undefined), 'context', 'without an anchor, knowledge sits in context');
  assert.equal(bandFor(ref('agent'), 'wf'), 'components');
  assert.equal(bandFor(ref('software'), 'wf'), 'components');
  assert.equal(bandFor(ref('ml'), 'wf'), 'components');
  assert.equal(bandFor(ref('dashboard'), 'wf'), 'components');
  assert.equal(bandFor(ref('data'), 'wf'), 'context');
  assert.equal(bandFor(ref('metric'), 'wf'), 'context');
  assert.equal(bandFor(ref('connection'), 'wf'), 'context');
});

test('banding: anchor sits above components, which sit above context', () => {
  const wf = ref('knowledge', 'wf');
  const agent = ref('agent', 'ag');
  const data = ref('data', 'da');
  const layout = layoutInterplay({ anchorId: 'wf', nodes: [data, agent, wf], edges: [] });

  const yOf = (id: string) => layout.nodes.find((n) => n.id === id)!.y;
  assert.ok(yOf('wf') < yOf('ag'), 'anchor above component');
  assert.ok(yOf('ag') < yOf('da'), 'component above context');

  assert.equal(layout.nodes.find((n) => n.id === 'wf')!.band, 'anchor');
  assert.equal(layout.nodes.find((n) => n.id === 'ag')!.band, 'components');
  assert.equal(layout.nodes.find((n) => n.id === 'da')!.band, 'context');
  // Only the three populated bands get a label row.
  assert.deepEqual(layout.bands.map((b) => b.band), ['anchor', 'components', 'context']);
});

test('banding: an empty band collapses (no orphan row) — components-only bet', () => {
  const layout = layoutInterplay({ nodes: [ref('agent', 'a'), ref('software', 's')], edges: [] });
  assert.deepEqual(layout.bands.map((b) => b.band), ['components'], 'only the populated band appears');
});

test('positions: a saved position overrides the packed slot; unsaved nodes keep the slot', () => {
  const a = ref('agent', 'a');
  const b = ref('agent', 'b');
  const layout = layoutInterplay({ nodes: [a, b], edges: [], positions: { a: { x: 500, y: 900 } } });
  const na = layout.nodes.find((n) => n.id === 'a')!;
  const nb = layout.nodes.find((n) => n.id === 'b')!;
  assert.deepEqual({ x: na.x, y: na.y }, { x: 500, y: 900 }, 'saved position honoured verbatim');
  assert.notEqual(nb.y, 900, 'unsaved node stays on the packed row');
  // A dragged-out node still fits inside the reported canvas height.
  assert.ok(layout.height >= na.y + na.h);
});

test('edges: route from source to target block anchors; down-edge leaves the bottom', () => {
  const wf = ref('knowledge', 'wf');
  const agent = ref('agent', 'ag');
  const layout = layoutInterplay({ anchorId: 'wf', nodes: [wf, agent], edges: [edge('wf', 'ag', 'triggers')] });
  assert.equal(layout.edges.length, 1);
  const [e] = layout.edges;
  const src = layout.nodes.find((n) => n.id === 'wf')!;
  const tgt = layout.nodes.find((n) => n.id === 'ag')!;
  assert.equal(e.relation, 'triggers');
  assert.equal(e.x1, src.x + src.w / 2, 'starts at source centre-x');
  assert.equal(e.y1, src.y + src.h, 'leaves the bottom of the higher source');
  assert.equal(e.y2, tgt.y, 'lands on the top of the lower target');
});

test('edges: an edge to a removed ref is skipped (never throws)', () => {
  const a = ref('agent', 'a');
  const layout = layoutInterplay({ nodes: [a], edges: [edge('a', 'ghost', 'feeds')] });
  assert.deepEqual(layout.edges, [], 'dangling edge dropped from the view');
});

test('empty blueprint: no nodes, no edges, still a valid (non-zero) canvas', () => {
  const layout = layoutInterplay({ nodes: [], edges: [] });
  assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.edges, []);
  assert.deepEqual(layout.bands, []);
  assert.ok(layout.width > 0 && layout.height > 0, 'a calm empty canvas has real dimensions');
});
