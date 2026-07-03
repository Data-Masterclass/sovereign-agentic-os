/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type System } from './system-schema.ts';
import { layoutSystem } from './canvas-layout.ts';

/**
 * Pure adapter: derive React Flow nodes + edges FROM the one source (`system.yaml`).
 * Kept dependency-free of `@xyflow/react` (its shapes are structurally compatible)
 * so it stays unit-testable and the client component only casts. The System stays
 * the source of truth; the canvas never holds authoritative graph state.
 *
 *   • Node positions: saved `ui.positions` win; missing ones fall back to the pure
 *     `layoutSystem` grid (so legacy files without positions still open tidy).
 *   • Edges: explicit `supervise`/`handoff` edges PLUS the derived member→supervise
 *     routes (the compiler fans out to a supervisor's members even without an
 *     explicit edge), deduped — mirroring canvas-layout.
 *   • Connection validation (`canConnect`) mirrors the canvas-edit rules so the UI
 *     PREVENTS a bad drop (no self-edge, no duplicate) instead of throwing after.
 */

export type FlowNodeData = {
  id: string;
  role: string;
  entrypoint: boolean;
  supervisor: boolean;
  disabled: boolean;
  tools: number;
  model: string | null;
};

export type FlowNode = {
  id: string;
  type: 'agent';
  position: { x: number; y: number };
  data: FlowNodeData;
};

export type FlowEdgeKind = 'supervise' | 'handoff';

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  /** Our custom edge renderer key (same value as data.edgeType). */
  type: FlowEdgeKind;
  label?: string;
  data: { edgeType: FlowEdgeKind; when?: string; derived: boolean };
};

/** Stable edge id for a directed typed pair (also our dedupe key). */
export function edgeId(from: string, to: string, type: FlowEdgeKind): string {
  return `${from}__${to}__${type}`;
}

export function nodesFromSystem(sys: System, opts: { disabledAgents?: string[] } = {}): FlowNode[] {
  const disabled = new Set(opts.disabledAgents ?? []);
  // Reuse the pure grid layout for FALLBACK positions only.
  const layout = layoutSystem(sys, { disabledAgents: [...disabled] });
  const fallback = new Map(layout.blocks.map((b) => [b.id, { x: b.x, y: b.y }]));
  const saved = sys.ui?.positions ?? {};
  return sys.agents.map((a) => ({
    id: a.id,
    type: 'agent' as const,
    position: saved[a.id] ?? fallback.get(a.id) ?? { x: 0, y: 0 },
    data: {
      id: a.id,
      role: a.role,
      entrypoint: a.id === sys.entrypoint,
      supervisor: (a.members?.length ?? 0) > 0,
      disabled: disabled.has(a.id),
      tools: (a.tools ?? sys.grants.tools).length,
      model: a.model ?? null,
    },
  }));
}

export function edgesFromSystem(sys: System): FlowEdge[] {
  const ids = new Set(sys.agents.map((a) => a.id));
  const out: FlowEdge[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, type: FlowEdgeKind, when: string | undefined, derived: boolean) => {
    if (!ids.has(from) || !ids.has(to)) return; // skip dangling (a compile error, not drawn)
    const id = edgeId(from, to, type);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, source: from, target: to, type, ...(when ? { label: when } : {}), data: { edgeType: type, when, derived } });
  };
  for (const e of sys.edges) push(e.from, e.to, e.type, e.when, false);
  // Derived member→supervise routes (membership without an explicit edge).
  for (const a of sys.agents) for (const m of a.members ?? []) push(a.id, m, 'supervise', undefined, true);
  return out;
}

/**
 * Would connecting `from`→`to` be a legal drop? Mirrors the canvas-edit guards so
 * React Flow's `isValidConnection` rejects at drag time (no thrown error later).
 * The supervise-vs-handoff decision is topological (entrypoint/supervisor source
 * ⇒ supervise) and lives in the caller; this only rules out illegal drops.
 */
export function canConnect(sys: System, from: string, to: string): { ok: boolean; reason?: string } {
  if (from === to) return { ok: false, reason: 'An agent cannot connect to itself' };
  const ids = new Set(sys.agents.map((a) => a.id));
  if (!ids.has(from) || !ids.has(to)) return { ok: false, reason: 'Unknown agent' };
  const fromAgent = sys.agents.find((a) => a.id === from);
  const isSupervisor = from === sys.entrypoint || (fromAgent?.members?.length ?? 0) > 0;
  const type: FlowEdgeKind = isSupervisor ? 'supervise' : 'handoff';
  if (type === 'supervise') {
    if (fromAgent?.members?.includes(to)) return { ok: false, reason: `${from} already supervises ${to}` };
  } else if (sys.edges.some((e) => e.from === from && e.to === to && e.type === 'handoff')) {
    return { ok: false, reason: `${from} already hands off to ${to}` };
  }
  return { ok: true };
}
