/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view (UI)
 * FEATURE:    The compiled LangGraph graph, drawn
 * USER STORY: As an engineer I want to see the compiled graph as a picture beside its JSON — the
 *             same nodes, the same edges, the same guards — so I can follow a run's path without
 *             reading 200 lines of JSON first (checklist T5).
 * ARCHITECTURE:
 *   - A thin shell over `@xyflow/react` (already a dependency; no new one) and the pure
 *     `layoutGraph`. Read-only: no dragging, no connecting — this is a view of a compiled
 *     artefact, not an editor (the Agents tab's canvas is the editor).
 *   - Every string drawn is a LangGraph node name or a `when` guard, verbatim from the graph.
 */
'use client';

import { useMemo } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { EngineeringGraph } from '@core/engineering/graph';
import { layoutGraph } from '@core/ui/engineering/graph-layout';

export function GraphDiagram({ graph }: { graph: EngineeringGraph }) {
  const { nodes, edges, height } = useMemo(() => layoutGraph(graph), [graph]);
  const flowNodes: Node[] = nodes.map((n) => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: n.label },
    draggable: false,
    connectable: false,
    style: {
      border: `1px solid ${n.phase === 'tools' ? 'var(--gold-line)' : 'var(--border-strong)'}`,
      background: n.agent ? 'var(--panel)' : 'var(--bg-elevated)',
      color: 'var(--text)',
      borderRadius: 8,
      padding: '6px 10px',
      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      fontSize: 12,
      width: 190,
    },
  }));
  const flowEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label ?? undefined,
    animated: false,
    style: { stroke: e.conditional ? 'var(--teal)' : 'var(--border-strong)', strokeDasharray: e.conditional ? '4 3' : undefined },
    labelStyle: { fill: 'var(--text-faint)', fontSize: 10 },
  }));
  return (
    <div style={{ height: Math.min(height, 560), border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
