/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  Panel,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

/**
 * The Gold JOIN graph — a calm, read-only picture of how the chosen datasets
 * interconnect. Nodes are the tables (the base Silver + each joined dataset); edges
 * are the join keys, labelled with `this.col = their.col` and the join type. It is a
 * pure VIEW of the guided join state (never authoritative) and updates as the user
 * picks datasets/keys. Based on the same React Flow pattern as the agents GraphCanvas,
 * but simplified: no editing on the canvas, no drag-to-connect — the pickers below
 * drive it. Offline-safe (npm-only, local CSS import, no CDN).
 */

export type JoinGraphTable = {
  /** 0 = the base Silver dataset; 1..n = each joined dataset (ref order). */
  ref: number;
  name: string;
  /** How many columns are being kept from this table (for the meta line). */
  kept?: number;
  base?: boolean;
};

export type JoinGraphEdge = {
  /** The already-joined table this key matches against (base or an earlier join). */
  fromRef: number;
  /** The joined table this edge lands on. */
  toRef: number;
  type: 'inner' | 'left';
  /** `this.col = their.col` label; `adapted` softly flags a reconciled key. */
  label: string;
  adapted?: boolean;
};

type TableNode = Node<{ name: string; kept?: number; base?: boolean }, 'jgTable'>;

function TableNodeView({ data }: NodeProps<TableNode>) {
  return (
    <div className={`jg-node${data.base ? ' is-base' : ''}`}>
      <Handle type="target" position={Position.Left} className="jg-handle" />
      <div className="jg-node-head">
        <span className="jg-node-name">{data.name}</span>
        {data.base ? <span className="jg-tag">this dataset</span> : null}
      </div>
      <div className="jg-node-meta">
        {typeof data.kept === 'number'
          ? `${data.kept} column${data.kept === 1 ? '' : 's'} kept`
          : 'joined dataset'}
      </div>
      <Handle type="source" position={Position.Right} className="jg-handle" />
    </div>
  );
}

function KeyEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const d = (data ?? {}) as { label?: string; type?: string; adapted?: boolean };
  const left = d.type === 'left';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: 'var(--gold)', strokeWidth: 1.6, strokeDasharray: left ? '6 4' : undefined, opacity: 0.9 }}
        markerEnd="url(#jg-arrow)"
      />
      <EdgeLabelRenderer>
        <div className="jg-edge-label" style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>
          <span className="jg-edge-key mono">{d.label}</span>
          <span className="jg-edge-type">{d.type} join{d.adapted ? ' · adapted' : ''}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { jgTable: TableNodeView };
const edgeTypes = { key: KeyEdge };

// Simple left-to-right column layout: base on the left, joins spread down/right.
const COL_W = 240;
const ROW_H = 120;

function layout(tables: JoinGraphTable[]): Record<number, { x: number; y: number }> {
  const out: Record<number, { x: number; y: number }> = {};
  tables.forEach((t, i) => {
    if (t.ref === 0) out[t.ref] = { x: 0, y: 0 };
    else out[t.ref] = { x: COL_W, y: (i - 1) * ROW_H - ((tables.length - 2) * ROW_H) / 2 };
  });
  return out;
}

function Flow({ tables, edges }: { tables: JoinGraphTable[]; edges: JoinGraphEdge[] }) {
  const pos = useMemo(() => layout(tables), [tables]);
  const nodes: TableNode[] = useMemo(
    () => tables.map((t) => ({
      id: String(t.ref),
      type: 'jgTable' as const,
      position: pos[t.ref] ?? { x: 0, y: 0 },
      data: { name: t.name, kept: t.kept, base: t.base },
      draggable: false,
      selectable: false,
    })),
    [tables, pos],
  );
  const rfEdges: Edge[] = useMemo(
    () => edges.map((e, i) => ({
      id: `e${i}`,
      source: String(e.fromRef),
      target: String(e.toRef),
      type: 'key',
      data: { label: e.label, type: e.type, adapted: e.adapted },
      selectable: false,
    })),
    [edges],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      fitView
      minZoom={0.4}
      maxZoom={1.5}
      panOnDrag
      zoomOnScroll={false}
    >
      <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
        <defs>
          <marker id="jg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--gold)" />
          </marker>
        </defs>
      </svg>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="jg-bg" />
      <Panel position="top-left" className="jg-legend">
        <span className="hint" style={{ margin: 0 }}>How your datasets connect — a key per line.</span>
      </Panel>
    </ReactFlow>
  );
}

export default function GoldJoinGraph({ tables, edges }: { tables: JoinGraphTable[]; edges: JoinGraphEdge[] }) {
  if (tables.length <= 1) {
    return (
      <div className="jg-wrap jg-empty">
        <div className="hint" style={{ margin: 0 }}>
          Pick a dataset to join and choose a key — the connection graph appears here.
        </div>
      </div>
    );
  }
  return (
    <div className="jg-wrap">
      <ReactFlowProvider>
        <Flow tables={tables} edges={edges} />
      </ReactFlowProvider>
    </div>
  );
}
