/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useRouter } from 'next/navigation';
import { layoutInterplay } from '@/lib/bigbets/interplay-layout';
import type { ComponentRef, SolutionEdge, InterplayRelation, Tab } from '@/lib/bigbets/model';

/**
 * The hand-rolled SVG interplay canvas over a bet's solution blueprint (clone of the
 * agent SystemCanvas). Nodes are ComponentRefs arranged in three type bands (anchor ▸
 * components ▸ context); edges are the runtime interplay relations. A thin renderer
 * over the pure `layoutInterplay`.
 *
 * Two modes:
 *   - READ (default): clicking a node deep-links to its home tab.
 *   - CONNECT (Phase 3, editor-only): `connectMode` turns clicks into a wire gesture —
 *     click the source node, then the target; the parent (Design) picks a relation and
 *     calls `wire_bet_components`. The canvas stays presentational: it emits the click,
 *     the parent owns the state machine + the write. Guarded by `canEdit` upstream.
 * No heavy graph dependency (air-gap clean).
 */

// Each tab's home surface. A component (data/agent/…) opens its detail page; the
// registry tabs (metric/knowledge/files/connection) open their list surface — the
// same routes the OS nav uses. Kept local (READ-only): tabs.ts is not ours to edit.
const TAB_ROUTE: Record<Tab, (artifactId: string) => string> = {
  data: (id) => `/data/${id}`,
  agent: (id) => `/agents/${id}`,
  software: (id) => `/software/${id}`,
  ml: (id) => `/science/${id}`,
  dashboard: (id) => `/dashboards/${id}`,
  metric: () => `/metrics`,
  knowledge: () => `/knowledge`,
  files: () => `/unstructured`,
  connection: () => `/connections`,
};

// A single-letter glyph + a house-palette accent per tab (gold/teal/navy only —
// no purple, per the taste rules). The accent tints the node's left rail.
const TAB_GLYPH: Record<Tab, string> = {
  data: '▤', metric: '∑', dashboard: '▦', software: '⌘', agent: '✦',
  ml: '∿', knowledge: '❦', files: '❏', connection: '⇄',
};
const TAB_ACCENT: Record<Tab, string> = {
  agent: 'var(--gold)',
  software: 'var(--navy)',
  ml: 'var(--teal)',
  dashboard: 'var(--gold-deep)',
  data: 'var(--teal-dim)',
  metric: 'var(--navy)',
  knowledge: 'var(--gold)',
  files: 'var(--text-faint)',
  connection: 'var(--teal)',
};

const TAB_LABEL_SHORT: Record<Tab, string> = {
  data: 'Data', metric: 'Metric', dashboard: 'Dashboard', software: 'Software',
  agent: 'Agent', ml: 'Model', knowledge: 'Knowledge', files: 'Files', connection: 'Connection',
};

// Dashed for the "signalling" relations (a trigger / a monitor is not a data flow).
const DASHED: InterplayRelation[] = ['triggers', 'monitors'];

export type NodeMeta = { title?: string; derived?: 'planned' | 'in-progress' | 'completed'; visible?: boolean };

export default function InterplayCanvas({
  anchorId,
  nodes,
  edges,
  positions,
  meta = {},
  connectMode = false,
  selectedFrom,
  onNodeClick,
}: {
  anchorId?: string;
  nodes: ComponentRef[];
  edges: SolutionEdge[];
  positions?: Record<string, { x: number; y: number }>;
  /** refId → live label + derived status, from the bet view (read-only badges). */
  meta?: Record<string, NodeMeta>;
  /** Editor-only: turn a node click into a wire gesture instead of a deep-link. */
  connectMode?: boolean;
  /** The ref id chosen as the wire SOURCE (highlighted) while awaiting the target. */
  selectedFrom?: string;
  /** In connect-mode, the parent handles the click (the source→target state machine). */
  onNodeClick?: (refId: string) => void;
}) {
  const router = useRouter();
  const layout = layoutInterplay({ anchorId, nodes, edges, positions });

  if (nodes.length === 0) {
    return (
      <div className="canvas-wrap">
        <div className="bb-canvas-empty">
          <div className="bb-canvas-empty-mark" aria-hidden="true">◇</div>
          <p>No solution components yet — add them in the wizard.</p>
        </div>
      </div>
    );
  }

  // In connect-mode a click feeds the parent's wire state machine; otherwise it
  // deep-links to the piece's home tab (the read-only behaviour).
  const activate = (n: { id: string; tab: Tab; artifactId: string }) => {
    if (connectMode && onNodeClick) onNodeClick(n.id);
    else router.push(TAB_ROUTE[n.tab](n.artifactId));
  };

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span className="canvas-hint">
          {connectMode
            ? selectedFrom
              ? 'Now click the target piece to draw the connection.'
              : 'Click the SOURCE piece, then its target, to connect them.'
            : 'Click a piece to open it in its home tab.'}
        </span>
      </div>

      <div className="canvas-scroll" role="group" aria-label="Solution interplay canvas">
        <svg width={Math.max(layout.width, 320)} height={Math.max(layout.height, 160)} className="canvas-svg">
          <defs>
            <marker id="bb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--teal)" />
            </marker>
            <marker id="bb-arrow-sig" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--gold)" />
            </marker>
          </defs>

          {/* Band labels down the left gutter. */}
          {layout.bands.map((b) => (
            <text key={b.band} x={8} y={b.y} className="bb-band-label" dominantBaseline="middle">
              {b.label}
            </text>
          ))}

          {layout.edges.map((e) => {
            const midX = (e.x1 + e.x2) / 2;
            const midY = (e.y1 + e.y2) / 2;
            const sig = DASHED.includes(e.relation);
            return (
              <g key={e.id} className="canvas-edge">
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  stroke={sig ? 'var(--gold)' : 'var(--teal)'}
                  strokeWidth={1.6}
                  strokeDasharray={sig ? '5 4' : undefined}
                  markerEnd={`url(#${sig ? 'bb-arrow-sig' : 'bb-arrow'})`}
                  opacity={0.85}
                />
                <text x={midX} y={midY - 6} textAnchor="middle" className="bb-edge-label">{e.relation}</text>
              </g>
            );
          })}

          {layout.nodes.map((n) => {
            const m = meta[n.id] ?? {};
            const title = m.visible === false ? 'Members only' : (m.title ?? TAB_LABEL_SHORT[n.tab]);
            const badge = statusBadge(m.derived);
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                className={`canvas-block${connectMode && selectedFrom === n.id ? ' selected' : ''}`}
                onClick={() => activate(n)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(n); }
                }}
              >
                <title>{TAB_LABEL_SHORT[n.tab]} · {title}</title>
                <rect width={n.w} height={n.h} rx={9} className="canvas-rect" />
                <rect x={0} y={0} width={4} height={n.h} rx={2} fill={TAB_ACCENT[n.tab]} />
                {n.anchor ? <rect width={n.w} height={n.h} rx={9} className="bb-anchor-ring" /> : null}
                <text x={16} y={22} className="bb-node-glyph" fill={TAB_ACCENT[n.tab]}>{TAB_GLYPH[n.tab]}</text>
                <text x={36} y={22} className="canvas-block-id">{TAB_LABEL_SHORT[n.tab]}</text>
                {n.anchor ? <text x={n.w - 12} y={22} textAnchor="end" className="canvas-tag">ANCHOR</text> : null}
                <text x={16} y={44} className="canvas-block-role">
                  {title.length > 24 ? `${title.slice(0, 24)}…` : title}
                </text>
                {badge ? (
                  <>
                    <circle cx={20} cy={60} r={4} fill={badge.color} />
                    <text x={30} y={63} className="bb-node-status">{badge.label}</text>
                  </>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="canvas-legend">
        <span><span className="legend-line" /> data flow (consumes · produces · feeds)</span>
        <span><span className="legend-line ho" /> signal (triggers · monitors)</span>
        <span className="muted">{nodes.length} piece{nodes.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

function statusBadge(derived?: 'planned' | 'in-progress' | 'completed'): { label: string; color: string } | null {
  if (derived === 'completed') return { label: 'ready', color: 'var(--teal)' };
  if (derived === 'in-progress') return { label: 'in progress', color: 'var(--gold)' };
  if (derived === 'planned') return { label: 'planned', color: 'var(--text-faint)' };
  return null;
}
