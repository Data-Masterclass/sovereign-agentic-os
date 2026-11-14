/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view (UI)
 * FEATURE:    Laying the compiled LangGraph graph out — one column per agent, one row per phase
 * USER STORY: As an engineer I want the graph diagram to be readable at a glance: every agent is a
 *             column, the `plan → act → tools → route` phases run down it, and START and END sit
 *             above and below, so the picture matches how the engine actually steps (checklist T5).
 * ARCHITECTURE:
 *   - PURE: graph in, positions out. No React, no layout engine — the graph's shape is known
 *     (four nodes per agent), so a grid is both correct and testable, and `@xyflow/react` only
 *     has to draw it.
 */
import { GRAPH_NODE_PHASES, type EngineeringGraph, type GraphNodePhase } from '@core/engineering/graph';

export type PlacedNode = { id: string; x: number; y: number; phase: GraphNodePhase; agent: string | null; label: string };
export type PlacedEdge = { id: string; source: string; target: string; label: string | null; conditional: boolean };
export type GraphLayout = { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number };

const COLUMN = 240;
const ROW = 96;
const PAD = 24;

/** Row per phase, in the order a run visits them. */
function rowOf(phase: GraphNodePhase): number {
  return GRAPH_NODE_PHASES.indexOf(phase);
}

/** The agents in column order: first appearance in `graph.nodes`. */
export function agentColumns(graph: EngineeringGraph): string[] {
  const out: string[] = [];
  for (const n of graph.nodes) if (n.agent && !out.includes(n.agent)) out.push(n.agent);
  return out;
}

/** Positions for every node and edge. Deterministic — the same graph lays out the same way. */
export function layoutGraph(graph: EngineeringGraph): GraphLayout {
  const columns = agentColumns(graph);
  const width = PAD * 2 + Math.max(1, columns.length) * COLUMN;
  const height = PAD * 2 + GRAPH_NODE_PHASES.length * ROW;
  const centre = width / 2 - COLUMN / 2;
  const nodes: PlacedNode[] = graph.nodes.map((n) => {
    const col = n.agent ? columns.indexOf(n.agent) : -1;
    return {
      id: n.id,
      x: col < 0 ? centre : PAD + col * COLUMN,
      y: PAD + rowOf(n.phase) * ROW,
      phase: n.phase,
      agent: n.agent,
      label: n.id,
    };
  });
  const edges: PlacedEdge[] = graph.edges.map((e, i) => ({
    id: `${e.from}->${e.to}#${i}`,
    source: e.from,
    target: e.to,
    label: e.when,
    conditional: e.kind !== 'direct',
  }));
  return { nodes, edges, width, height };
}
