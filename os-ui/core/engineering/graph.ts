/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    The compiled-graph structure the LangGraph section carries (JSON, then a diagram)
 * USER STORY: As an engineer I want to see the graph the OS actually compiled — the `plan`/`act`/
 *             `tools`/`route` nodes of each agent, the conditional edges, the `when` guards, the
 *             state channels and where a run parks on `interrupt()` — as JSON I can read and as a
 *             diagram I can follow (checklist T5).
 * ARCHITECTURE:
 *   - PURE types + the serialiser. The derivation from a `system.yaml` lives in the Agents tab
 *     (`tabs/agents/lib/engineering.ts`), because only the tab may know the compiler; the kernel
 *     only has to be able to carry and draw the result.
 *   - `graphJson` is what the panel and the MCP both show, so there is one byte sequence for the
 *     graph and no chance of the panel pretty-printing something the MCP does not return.
 */

/** The four phases every agent compiles to in `build-graph.ts`, plus the graph's own terminals. */
export const GRAPH_NODE_PHASES = ['start', 'plan', 'act', 'tools', 'route', 'end'] as const;
export type GraphNodePhase = (typeof GRAPH_NODE_PHASES)[number];

/** One LangGraph node: the real node NAME the builder registered (`plan_<agent>`, …). */
export type GraphNode = {
  /** The LangGraph node name, verbatim (`START`, `plan_analyst`, `END`). */
  id: string;
  phase: GraphNodePhase;
  /** The agent whose node this is, or null for START/END. */
  agent: string | null;
};

/** One edge, in the terms LangGraph's builder uses. */
export type GraphEdge = {
  from: string;
  to: string;
  /** `addEdge` · `addConditionalEdges` · a `Command(goto)` handoff. */
  kind: 'direct' | 'conditional' | 'command';
  /** The `when` guard of a handoff, verbatim from `system.yaml`; null when unguarded. */
  when: string | null;
};

/** A state channel as declared, e.g. `draft: string`. */
export type GraphChannel = { name: string; declaration: string };

/** Where a run can park, and what parks it. */
export type GraphInterrupt = { node: string; reason: string };

/** The compiled graph, serialisable. */
export type EngineeringGraph = {
  entrypoint: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  channels: GraphChannel[];
  interrupts: GraphInterrupt[];
  /** The checkpointer the graph was compiled with, named as the tool names it. */
  checkpointer: string;
  /** How `thread_id` relates to the OS run id — one line, because engineers ask first. */
  threadIdSemantics: string;
  /** What `resume` does after an interrupt — one line. */
  resumeSemantics: string;
};

/** The exact bytes the panel shows and `get_engineering_view` returns — one serialisation. */
export function graphJson(graph: EngineeringGraph): string {
  return JSON.stringify(graph, null, 2);
}
