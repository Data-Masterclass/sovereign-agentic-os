/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { layoutSystem } from '@/lib/agents/canvas-layout';
import type { System } from '@/lib/agents/system-schema';

/**
 * The hand-rolled SVG system canvas — a VIEW of system.yaml (Approach A). Blocks
 * are agents, edges are supervise/handoff. It is a thin renderer over the pure
 * `layoutSystem`; all edits flow back through the callbacks as system.yaml
 * mutations (canvas-edit), so the canvas, the Monaco file panel and the
 * agent-system chat all edit the one source.
 *
 * Connect mode: click a source block, then a target → onConnect(from, to). The
 * parent decides supervise-vs-handoff and commits the diff. Selecting a block
 * opens the Level-3 agent editor. No heavy graph dependency (air-gap clean).
 */
export default function SystemCanvas({
  system,
  disabledAgents = [],
  selectedId,
  canEdit,
  compileError,
  onSelectAgent,
  onConnect,
  onRemoveEdge,
}: {
  system: System;
  disabledAgents?: string[];
  selectedId?: string | null;
  canEdit: boolean;
  compileError?: string | null;
  onSelectAgent?: (id: string) => void;
  onConnect?: (from: string, to: string) => void;
  onRemoveEdge?: (from: string, to: string, type: 'supervise' | 'handoff') => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const layout = layoutSystem(system, { disabledAgents });

  const blockClick = (id: string) => {
    if (connecting && canEdit) {
      if (!pendingFrom) {
        setPendingFrom(id);
      } else if (pendingFrom !== id) {
        onConnect?.(pendingFrom, id);
        setPendingFrom(null);
        setConnecting(false);
      } else {
        setPendingFrom(null);
      }
      return;
    }
    onSelectAgent?.(id);
  };

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span className="canvas-hint">
          {connecting
            ? pendingFrom
              ? `Connecting from “${pendingFrom}” — click a target block`
              : 'Click a source block to start a connection'
            : 'Click an agent to edit it.'}
        </span>
        {canEdit ? (
          <button
            className={`btn ghost sm${connecting ? ' active' : ''}`}
            onClick={() => {
              setConnecting((c) => !c);
              setPendingFrom(null);
            }}
          >
            {connecting ? 'Cancel connect' : '+ Connect agents'}
          </button>
        ) : null}
      </div>

      {compileError ? (
        <div className="error" style={{ margin: '0 0 10px' }}>
          Graph does not compile yet — <span className="mono">{compileError}</span>
        </div>
      ) : null}

      <div className="canvas-scroll" role="group" aria-label="Agent system canvas">
        <svg
          width={Math.max(layout.width, 320)}
          height={Math.max(layout.height, 160)}
          className="canvas-svg"
        >
          <defs>
            <marker id="arrow-sup" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--gold)" />
            </marker>
            <marker id="arrow-ho" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--teal)" />
            </marker>
          </defs>

          {layout.edges.map((e, i) => {
            const midX = (e.x1 + e.x2) / 2;
            const midY = (e.y1 + e.y2) / 2;
            const sup = e.type === 'supervise';
            return (
              <g key={`${e.from}-${e.to}-${e.type}-${i}`} className="canvas-edge">
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={sup ? 'var(--gold)' : 'var(--teal)'}
                  strokeWidth={1.6}
                  strokeDasharray={sup ? undefined : '5 4'}
                  markerEnd={`url(#${sup ? 'arrow-sup' : 'arrow-ho'})`}
                  opacity={0.85}
                />
                {canEdit ? (
                  <circle
                    cx={midX}
                    cy={midY}
                    r={8}
                    className="canvas-edge-x"
                    onClick={() => onRemoveEdge?.(e.from, e.to, e.type)}
                  >
                    <title>Remove {e.type} edge {e.from} → {e.to}</title>
                  </circle>
                ) : null}
                {e.when ? (
                  <text x={midX} y={midY - 11} textAnchor="middle" className="canvas-when">{e.when}</text>
                ) : null}
              </g>
            );
          })}

          {layout.blocks.map((b) => {
            const selected = b.id === selectedId;
            const pending = b.id === pendingFrom;
            return (
              <g
                key={b.id}
                transform={`translate(${b.x},${b.y})`}
                className={`canvas-block${b.disabled ? ' disabled' : ''}${selected ? ' selected' : ''}${pending ? ' pending' : ''}`}
                onClick={() => blockClick(b.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    blockClick(b.id);
                  }
                }}
              >
                <rect width={b.w} height={b.h} rx={9} className="canvas-rect" />
                {b.entrypoint ? <rect x={0} y={0} width={4} height={b.h} rx={2} className="canvas-entry-bar" /> : null}
                <text x={14} y={24} className="canvas-block-id">{b.id}</text>
                <text x={14} y={43} className="canvas-block-role">
                  {b.role.length > 26 ? `${b.role.slice(0, 26)}…` : b.role}
                </text>
                <text x={14} y={66} className="canvas-block-meta">
                  {b.supervisor ? 'supervisor · ' : ''}{b.tools} tool{b.tools === 1 ? '' : 's'}
                  {b.model ? ` · ${b.model.length > 14 ? `${b.model.slice(0, 14)}…` : b.model}` : ''}
                </text>
                {b.entrypoint ? <text x={b.w - 12} y={24} textAnchor="end" className="canvas-tag">START</text> : null}
                {b.disabled ? <text x={b.w - 12} y={66} textAnchor="end" className="canvas-tag off">OFF</text> : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="canvas-legend">
        <span><span className="legend-line sup" /> supervise</span>
        <span><span className="legend-line ho" /> handoff</span>
        <span className="muted">{system.agents.length} agent{system.agents.length === 1 ? '' : 's'} · entrypoint <span className="mono">{system.entrypoint || '—'}</span></span>
      </div>
    </div>
  );
}
