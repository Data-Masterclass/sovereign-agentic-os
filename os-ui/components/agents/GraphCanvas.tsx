/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  type Connection,
  type NodeChange,
  type OnConnectStartParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { System } from '@/lib/agents/system-schema';
import {
  nodesFromSystem,
  edgesFromSystem,
  canConnect,
  type FlowNodeData,
  type FlowEdge,
} from '@/lib/agents/flow-adapter';

/**
 * The interactive LangGraph-grade builder (React Flow v12, MIT). A VIEW of
 * `system.yaml`: nodes are agents, edges are supervise (gold, solid) / handoff
 * (teal, dashed). All edits flow back as system.yaml mutations through the parent's
 * callbacks — the System stays the single source of truth; the canvas never holds
 * authoritative graph state. Offline-safe (npm-only, local CSS import, no CDN).
 *
 * Guided for non-technical builders: a teaching empty state, an always-visible
 * "+ Add agent" affordance, drag-to-connect with drop-time validation (bad drops
 * are prevented, not thrown), a run status overlay, and a "Tidy up" auto-layout.
 */

export type RunNodeState = 'idle' | 'running' | 'ok' | 'error';

type AgentNode = Node<FlowNodeData, 'agent'>;

// ---- module-scope type maps (else nodes/edges remount every render) ----------

function AgentNodeView({ data, selected }: NodeProps<AgentNode>) {
  const run = (data as FlowNodeData & { run?: RunNodeState }).run ?? 'idle';
  return (
    <div
      className={[
        'gc-node',
        data.entrypoint ? 'is-entry' : '',
        data.supervisor ? 'is-supervisor' : '',
        data.disabled ? 'is-off' : '',
        selected ? 'is-selected' : '',
        `run-${run}`,
      ].filter(Boolean).join(' ')}
    >
      <Handle type="target" position={Position.Top} className="gc-handle" />
      {data.entrypoint ? <span className="gc-node-bar" aria-hidden /> : null}
      <div className="gc-node-head">
        <span className="gc-node-id">{data.id}</span>
        <span className="gc-node-badges">
          {data.entrypoint ? <span className="gc-tag start">START</span> : null}
          {data.supervisor ? <span className="gc-tag sup">supervisor</span> : null}
          {data.disabled ? <span className="gc-tag off">off</span> : null}
        </span>
      </div>
      <div className="gc-node-role">{data.role || 'no role yet'}</div>
      <div className="gc-node-meta">
        {data.tools} tool{data.tools === 1 ? '' : 's'}
        {data.model ? <> · <span className="mono">{data.model.length > 16 ? `${data.model.slice(0, 16)}…` : data.model}</span></> : ' · auto model'}
      </div>
      {run !== 'idle' ? <span className={`gc-run-dot run-${run}`} title={`run: ${run}`} /> : null}
      <Handle type="source" position={Position.Bottom} className="gc-handle" />
    </div>
  );
}

function TypedEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const d = (data ?? {}) as FlowEdge['data'];
  const supervise = d.edgeType === 'supervise';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: supervise ? 'var(--gold)' : 'var(--teal)',
          strokeWidth: selected ? 2.4 : 1.6,
          strokeDasharray: supervise ? undefined : '6 4',
          opacity: 0.9,
        }}
        markerEnd={supervise ? 'url(#gc-arrow-sup)' : 'url(#gc-arrow-ho)'}
      />
      <EdgeLabelRenderer>
        <div className="gc-edge-label" style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>
          {d.when ? <span className="gc-edge-when">{d.when}</span> : null}
          {!d.derived ? (
            <button
              className="gc-edge-x"
              title={`Remove ${d.edgeType} edge`}
              onClick={(e) => { e.stopPropagation(); void deleteElements({ edges: [{ id }] }); }}
            >
              ×
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { agent: AgentNodeView };
const edgeTypes = { supervise: TypedEdge, handoff: TypedEdge };

// ---- dagre auto-layout ("Tidy up") -------------------------------------------

const NODE_W = 190;
const NODE_H = 92;

function dagreLayout(nodes: AgentNode[], edges: Edge[]): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 84, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) out[n.id] = { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) };
  }
  return out;
}

// ---- the flow ----------------------------------------------------------------

export type GraphCanvasProps = {
  system: System;
  disabledAgents: string[];
  selectedId: string | null;
  canEdit: boolean;
  compileError: string | null;
  /** Optional per-agent run status merged onto nodes for the run overlay. */
  runState?: Record<string, RunNodeState>;
  /** Bump to force a resync from the (reloaded) System after an external edit. */
  syncKey?: number;
  onSelectAgent: (id: string | null) => void;
  onConnect: (from: string, to: string) => void;
  onRemoveEdge: (from: string, to: string, type: 'supervise' | 'handoff') => void;
  onRemoveAgent: (id: string) => void;
  onMoveNodes: (positions: Record<string, { x: number; y: number }>) => void;
  onAddAgent: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
};

function Flow(props: GraphCanvasProps) {
  const { system, disabledAgents, selectedId, canEdit, runState, syncKey, onSelectAgent, onConnect, onRemoveEdge, onRemoveAgent, onMoveNodes, onAddAgent, onUndo, onRedo, canUndo, canRedo } = props;
  const { fitView } = useReactFlow();

  // Derive RF state FROM the System (source of truth), re-syncing on syncKey.
  const buildNodes = useCallback((): AgentNode[] => {
    const base = nodesFromSystem(system, { disabledAgents });
    return base.map((n) => ({
      id: n.id,
      type: 'agent' as const,
      position: n.position,
      selected: n.id === selectedId,
      data: { ...n.data, run: runState?.[n.id] ?? 'idle' } as FlowNodeData,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, disabledAgents, runState, selectedId]);

  const buildEdges = useCallback((): Edge[] =>
    edgesFromSystem(system).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.type,
      data: e.data,
      deletable: !e.data.derived,
    })), [system]);

  const [nodes, setNodes] = useState<AgentNode[]>(buildNodes);
  const [edges, setEdges] = useState<Edge[]>(buildEdges);

  // Resync whenever the source changes (external YAML edit, add/remove, reload).
  useEffect(() => { setNodes(buildNodes()); setEdges(buildEdges()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [syncKey, system]);

  // Debounced position commit so a drag persists once, not per-frame.
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPos = useRef<Record<string, { x: number; y: number }>>({});

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((cur) => {
      const next = [...cur];
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          const i = next.findIndex((n) => n.id === c.id);
          if (i >= 0) next[i] = { ...next[i], position: c.position };
          if (!c.dragging && canEdit) pendingPos.current[c.id] = c.position; // commit on drag end
        } else if (c.type === 'select') {
          const i = next.findIndex((n) => n.id === c.id);
          if (i >= 0) next[i] = { ...next[i], selected: c.selected };
        }
      }
      return next;
    });
    if (Object.keys(pendingPos.current).length > 0) {
      if (moveTimer.current) clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(() => {
        const batch = pendingPos.current;
        pendingPos.current = {};
        if (Object.keys(batch).length > 0) onMoveNodes(batch);
      }, 500);
    }
  }, [canEdit, onMoveNodes]);

  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (!c.source || !c.target) return false;
    return canConnect(system, c.source, c.target).ok;
  }, [system]);

  const handleConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    if (canConnect(system, c.source, c.target).ok) onConnect(c.source, c.target);
  }, [system, onConnect]);

  // Drop an edge on empty canvas → offer to add a new agent (kills blank-canvas).
  const connectingFrom = useRef<string | null>(null);
  const onConnectStart = useCallback((_: unknown, p: OnConnectStartParams) => { connectingFrom.current = p.nodeId ?? null; }, []);
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const target = event.target as Element | null;
    const droppedOnPane = target?.classList?.contains('react-flow__pane');
    if (droppedOnPane && connectingFrom.current && canEdit) onAddAgent();
    connectingFrom.current = null;
  }, [canEdit, onAddAgent]);

  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    for (const e of deleted) {
      const d = (e.data ?? {}) as FlowEdge['data'];
      if (!d.derived) onRemoveEdge(e.source, e.target, d.edgeType);
    }
  }, [onRemoveEdge]);

  const onNodesDelete = useCallback((deleted: Node[]) => {
    for (const n of deleted) if (n.id !== system.entrypoint) onRemoveAgent(n.id);
  }, [onRemoveAgent, system.entrypoint]);

  const tidyUp = useCallback(() => {
    const positions = dagreLayout(nodes, edges);
    setNodes((cur) => cur.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)));
    onMoveNodes(positions);
    setTimeout(() => fitView({ duration: 300, padding: 0.2 }), 60);
  }, [nodes, edges, onMoveNodes, fitView]);

  const empty = system.agents.length === 0;

  return (
    <div className="gc-wrap">
      <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
        <defs>
          <marker id="gc-arrow-sup" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--gold)" />
          </marker>
          <marker id="gc-arrow-ho" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--teal)" />
          </marker>
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={handleConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeClick={(_, n) => onSelectAgent(n.id)}
        onPaneClick={() => onSelectAgent(null)}
        nodesConnectable={canEdit}
        nodesDraggable={canEdit}
        elementsSelectable
        deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : []}
        proOptions={{ hideAttribution: true }}
        fitView
        minZoom={0.3}
        maxZoom={1.75}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="gc-bg" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="gc-minimap" nodeColor={(n) => ((n.data as FlowNodeData)?.entrypoint ? 'var(--gold)' : 'var(--teal)')} />

        <Panel position="top-left" className="gc-toolbar">
          {canEdit ? <button className="btn sm" onClick={onAddAgent}>+ Add agent</button> : null}
          <button className="btn ghost sm" onClick={() => fitView({ duration: 300, padding: 0.2 })}>Fit</button>
          {canEdit ? <button className="btn ghost sm" onClick={tidyUp} disabled={empty}>Tidy up</button> : null}
          {onUndo ? <button className="btn ghost sm" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">↶</button> : null}
          {onRedo ? <button className="btn ghost sm" onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)">↷</button> : null}
        </Panel>

        {empty ? (
          <Panel position="top-center" className="gc-empty">
            <div className="gc-empty-card">
              <div className="gc-empty-title">Your canvas is empty</div>
              <p className="gc-empty-body">
                An agent system is a team of AI agents wired together. Add your first agent — it becomes
                the <strong>START</strong>. Then drag from the dot under one agent to another to connect them.
              </p>
              {canEdit ? <button className="btn" onClick={onAddAgent}>+ Add your first agent</button> : null}
            </div>
          </Panel>
        ) : null}
      </ReactFlow>

      <div className="gc-legend">
        <span><span className="gc-legend-line sup" /> supervise</span>
        <span><span className="gc-legend-line ho" /> handoff</span>
        <span className="muted">drag a dot to connect · click a node to configure · Del to remove</span>
      </div>
    </div>
  );
}

export default function GraphCanvas(props: GraphCanvasProps) {
  // A stable provider per system so RF internals reset cleanly on switch.
  const key = useMemo(() => props.system.system.name, [props.system.system.name]);
  return (
    <ReactFlowProvider key={key}>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
