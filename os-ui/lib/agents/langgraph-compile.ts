/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type System, SystemError } from './system-schema.ts';

/**
 * The PURE `system.yaml` → LangGraph IR compiler (Approach A). It validates the
 * graph SEMANTICS and emits a deterministic intermediate representation the
 * LangGraph build adapter turns into a runnable graph (and the canvas renders):
 *
 *   • each agent          → a ReAct node (AGENT.md prompt, MEMORY.md context,
 *                            narrowed tools, routed model)
 *   • entrypoint          → add_edge(START, entrypoint)
 *   • supervisor+members  → add_conditional_edges(router → members ∪ END)
 *   • `supervise` edge    → member edge back to the supervisor
 *   • `handoff` edge      → Command(goto, guarded by `when`)
 *
 * NARROW-ONLY is enforced here: an agent tool not ⊆ the system grants is a
 * compile error, so a sub-agent can never broaden its authority.
 */

export type IRNode = {
  id: string;
  kind: 'react';
  prompt: string;
  memory: string;
  tools: string[];
  /** Resolved per-agent model, or null to fall back to activity routing. */
  model: string | null;
  supervisor: boolean;
  members: string[];
};

/** add_conditional_edges: the router fans out to its members ∪ END. */
export type IRConditional = { source: string; targets: string[] };
/** A `handoff` compiled to Command(goto, guarded by `when`). */
export type IRCommand = { from: string; to: string; when: string | null };

export type IR = {
  entrypoint: string;
  startEdge: { from: 'START'; to: string };
  nodes: IRNode[];
  /** `supervise` return edges: member → supervisor. */
  memberEdges: { from: string; to: string }[];
  conditionalEdges: IRConditional[];
  commands: IRCommand[];
  channels: Record<string, string>;
};

export function compile(sys: System): IR {
  const ids = new Set<string>();
  for (const a of sys.agents) {
    if (ids.has(a.id)) throw new SystemError(`system.yaml: duplicate agent id '${a.id}'`);
    ids.add(a.id);
  }
  if (sys.agents.length === 0) throw new SystemError('system.yaml: at least one agent is required');

  if (!sys.entrypoint) throw new SystemError("system.yaml: 'entrypoint' is required");
  if (!ids.has(sys.entrypoint)) {
    throw new SystemError(`system.yaml: entrypoint '${sys.entrypoint}' is not a declared agent`);
  }

  const granted = new Set(sys.grants.tools);

  const nodes: IRNode[] = sys.agents.map((a) => {
    // Narrow-only: an explicit tool list must be a subset of the system grants.
    if (a.tools) {
      for (const t of a.tools) {
        if (!granted.has(t)) {
          throw new SystemError(`system.yaml: agent '${a.id}' requests tool '${t}' not granted to the system (narrow-only)`);
        }
      }
    }
    // Supervisor members must be declared agents.
    const members = a.members ?? [];
    for (const m of members) {
      if (!ids.has(m)) throw new SystemError(`system.yaml: agent '${a.id}' supervises unknown member '${m}'`);
    }
    return {
      id: a.id,
      kind: 'react',
      prompt: a.agent_md,
      memory: a.memory_md,
      tools: a.tools ? [...a.tools] : [...sys.grants.tools],
      model: a.model ?? null,
      supervisor: members.length > 0,
      members,
    };
  });

  // Edges: every endpoint must be a declared agent (no dangling edges).
  const memberEdges: { from: string; to: string }[] = [];
  const commands: IRCommand[] = [];
  for (const e of sys.edges) {
    for (const end of [e.from, e.to]) {
      if (!ids.has(end)) {
        throw new SystemError(`system.yaml: edge '${e.from}' -> '${e.to}' references unknown agent '${end}'`);
      }
    }
    if (e.type === 'supervise') {
      // Control returns from the member to the supervisor after it runs.
      memberEdges.push({ from: e.to, to: e.from });
    } else {
      commands.push({ from: e.from, to: e.to, when: e.when ?? null });
    }
  }

  const conditionalEdges: IRConditional[] = nodes
    .filter((n) => n.supervisor)
    .map((n) => ({ source: n.id, targets: [...n.members, 'END'] }));

  return {
    entrypoint: sys.entrypoint,
    startEdge: { from: 'START', to: sys.entrypoint },
    nodes,
    memberEdges,
    conditionalEdges,
    commands,
    channels: sys.state.channels,
  };
}
