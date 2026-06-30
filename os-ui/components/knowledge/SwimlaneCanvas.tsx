/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { layoutSwimlanes } from '@/lib/knowledge/swimlane-layout';
import type { Workflow } from '@/lib/knowledge/schema';
import type { Gap } from '@/lib/knowledge/gaps';

/**
 * The hand-rolled SVG swimlane — a VIEW of `workflow.md` (clone of SystemCanvas).
 * Actor-colored vertical lanes (Human / Software / Agent); steps flow top→bottom
 * in sequence inside their actor's column; sequential connectors join them. A thin
 * renderer over the pure `layoutSwimlanes`; selecting a step opens the inspector.
 * No heavy graph dependency (air-gap clean).
 *
 * Gaps (a link to a missing entity) are surfaced as a small warning marker on the
 * step; the inspector lists the jump-to-build action.
 */

const ACTOR_FILL: Record<string, string> = {
  Human: 'var(--teal)',
  Software: 'var(--navy)',
  Agent: 'var(--gold)',
};

export default function SwimlaneCanvas({
  workflow,
  gaps = [],
  selectedStepId,
  canEdit,
  onSelectStep,
}: {
  workflow: Workflow;
  gaps?: Gap[];
  selectedStepId?: string | null;
  canEdit: boolean;
  onSelectStep?: (id: string) => void;
}) {
  // Per-step gap counts derived from the server-computed gaps list.
  const gapByStep = new Map<string, number>();
  for (const g of gaps) gapByStep.set(g.stepId, (gapByStep.get(g.stepId) ?? 0) + 1);
  const layout = layoutSwimlanes(workflow, { gapFor: (s) => gapByStep.get(s.id) ?? 0 });

  return (
    <div className="swim-wrap">
      <div className="swim-toolbar">
        <span className="swim-hint">
          {canEdit ? 'Click a step to edit its actor, inputs/outputs, links and rules.' : 'Read-only view.'}
        </span>
        <div className="swim-legend">
          <span><span className="swim-dot" style={{ background: 'var(--teal)' }} /> Human</span>
          <span><span className="swim-dot" style={{ background: 'var(--navy)' }} /> Software</span>
          <span><span className="swim-dot" style={{ background: 'var(--gold)' }} /> Agent</span>
        </div>
      </div>

      <div className="swim-scroll" role="group" aria-label="Workflow swimlane">
        {layout.blocks.length === 0 ? (
          <div className="swim-empty muted">No steps yet — add the first step below.</div>
        ) : (
          <svg
            width={Math.max(layout.width, 320)}
            height={Math.max(layout.height, 120)}
            className="swim-svg"
          >
            <defs>
              <marker id="swim-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--text-faint)" />
              </marker>
            </defs>

            {/* Lane backgrounds + labels (one vertical column per actor) */}
            {layout.lanes.map((lane) => (
              <g key={lane.actor} className="swim-lane">
                <rect
                  x={lane.x + 4}
                  y={4}
                  width={lane.width - 8}
                  height={layout.height - 8}
                  rx={8}
                  fill={ACTOR_FILL[lane.actor]}
                  fillOpacity={0.05}
                  stroke={ACTOR_FILL[lane.actor]}
                  strokeOpacity={0.18}
                />
                <text
                  x={lane.x + lane.width / 2}
                  y={22}
                  textAnchor="middle"
                  className="swim-lane-label"
                  fill={ACTOR_FILL[lane.actor]}
                >
                  {lane.actor.toUpperCase()}
                </text>
              </g>
            ))}

            {/* Connectors */}
            {layout.edges.map((e, i) => (
              <line
                key={`${e.from}-${e.to}-${i}`}
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="var(--text-faint)"
                strokeWidth={1.5}
                markerEnd="url(#swim-arrow)"
                opacity={0.6}
              />
            ))}

            {/* Step blocks */}
            {layout.blocks.map((b) => {
              const selected = b.id === selectedStepId;
              const fill = ACTOR_FILL[b.actor] ?? 'var(--gold)';
              return (
                <g
                  key={b.id}
                  transform={`translate(${b.x},${b.y})`}
                  className={`swim-block${selected ? ' selected' : ''}`}
                  onClick={() => onSelectStep?.(b.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelectStep?.(b.id); }
                  }}
                >
                  <rect width={b.w} height={b.h} rx={9} className="swim-rect" stroke={fill} />
                  <rect x={0} y={0} width={4} height={b.h} rx={2} fill={fill} />
                  <text x={14} y={22} className="swim-block-title">
                    {b.title.length > 22 ? `${b.title.slice(0, 22)}…` : b.title}
                  </text>
                  <text x={14} y={40} className="swim-block-actor" fill={fill}>
                    {b.actorName ? `${b.actor}: ${b.actorName}` : b.actor}
                  </text>
                  <text x={14} y={62} className="swim-block-meta">
                    {b.inputs > 0 ? `${b.inputs}in ` : ''}
                    {b.outputs > 0 ? `${b.outputs}out ` : ''}
                    {b.links > 0 ? `· ${b.links} link${b.links === 1 ? '' : 's'}` : ''}
                  </text>
                  {b.hasHardRule ? <text x={b.w - 12} y={22} textAnchor="end" className="swim-mark hard">🔒</text> : null}
                  {b.hasTacit ? <text x={b.w - 12} y={40} textAnchor="end" className="swim-mark tacit">✎</text> : null}
                  {b.gaps > 0 ? (
                    <g>
                      <text x={b.w - 12} y={62} textAnchor="end" className="swim-mark gap">⚠ {b.gaps}</text>
                      <title>{b.gaps} link{b.gaps === 1 ? '' : 's'} reference a missing entity — open the step to jump-to-build</title>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <style>{SwimStyles}</style>
    </div>
  );
}

const SwimStyles = `
.swim-wrap {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  padding: 12px;
}
.swim-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.swim-hint { font-size: 12px; color: var(--text-muted); }
.swim-legend { display: flex; gap: 14px; font-size: 11px; color: var(--text-muted); }
.swim-legend span { display: inline-flex; align-items: center; gap: 5px; }
.swim-dot { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
.swim-scroll { overflow-y: auto; overflow-x: auto; max-height: 72vh; }
.swim-empty { padding: 28px; text-align: center; font-size: 13px; }
.swim-svg { display: block; }
.swim-lane-label {
  font-family: var(--font-head);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.2px;
  opacity: 0.8;
}
.swim-block { cursor: pointer; }
.swim-rect {
  fill: var(--bg);
  stroke-width: 1.4;
  transition: filter 0.14s;
}
.swim-block:hover .swim-rect { filter: brightness(1.02); stroke-width: 2; }
.swim-block.selected .swim-rect { stroke-width: 2.5; filter: drop-shadow(0 0 6px rgba(200,162,74,0.3)); }
.swim-block-title { font-size: 13px; font-weight: 600; fill: var(--text); font-family: var(--font-body); }
.swim-block-actor { font-size: 11px; font-weight: 500; }
.swim-block-meta { font-size: 10.5px; fill: var(--text-faint); }
.swim-mark { font-size: 11px; }
.swim-mark.gap { fill: var(--danger); font-weight: 600; }
`;
