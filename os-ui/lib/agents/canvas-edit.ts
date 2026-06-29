/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type AgentSpec, type EdgeType, type System, SystemError } from './system-schema.ts';

/**
 * Pure, immutable `system.yaml` mutations for the hand-rolled SVG canvas (Task 3,
 * canvas ⇄ system.yaml). Dragging on the canvas (add agent / connect / remove)
 * produces a NEW {@link System} the caller serializes and commits through the SAME
 * store file write the Monaco panel + the agent-system chat use — one source of
 * truth, three interchangeable editors.
 *
 * Every mutation `structuredClone`s its input (never mutates) and keeps the graph
 * coherent so it still compiles: a `supervise` connection both registers the
 * member on the supervisor (so the router fans out to it) AND records the return
 * edge; removing an agent also drops its edges and membership references. Deep
 * semantic validation (narrow-only tools, dangling edges) stays in the compiler.
 */

function requireAgent(sys: System, id: string, what: string): AgentSpec {
  const a = sys.agents.find((x) => x.id === id);
  if (!a) throw new SystemError(`Canvas: ${what} '${id}' is not a declared agent (unknown)`);
  return a;
}

/** Add a fresh ReAct agent. It inherits the system grants (no per-agent narrowing). */
export function addAgent(input: System, opts: { id: string; role?: string }): System {
  const id = opts.id.trim();
  if (!/^[a-z][\w-]*$/i.test(id)) {
    throw new SystemError(`Canvas: '${opts.id}' is not a valid agent id (letters, digits, - and _; must start with a letter)`);
  }
  if (input.agents.some((a) => a.id === id)) {
    throw new SystemError(`Canvas: an agent '${id}' already exists`);
  }
  const sys = structuredClone(input);
  const agent: AgentSpec = {
    id,
    role: opts.role?.trim() || 'A sub-agent',
    agent_md: `# ${id}\n\nA ${opts.role?.trim() || 'sub'}-agent in the Sovereign Agentic OS.\nUse only your granted, governed tools.`,
    memory_md: '',
  };
  sys.agents.push(agent);
  return sys;
}

/** Remove an agent plus every edge + membership that referenced it. */
export function removeAgent(input: System, id: string): System {
  requireAgent(input, id, 'agent');
  if (input.entrypoint === id) {
    throw new SystemError(`Canvas: cannot remove '${id}' — it is the entrypoint (set a new entrypoint first)`);
  }
  const sys = structuredClone(input);
  sys.agents = sys.agents.filter((a) => a.id !== id);
  for (const a of sys.agents) {
    if (a.members) a.members = a.members.filter((m) => m !== id);
  }
  sys.edges = sys.edges.filter((e) => e.from !== id && e.to !== id);
  return sys;
}

/**
 * Connect a supervisor to a member: register the member on the supervisor (the
 * router fans out to it) and record the `supervise` return edge. Idempotent.
 */
export function addSuperviseEdge(input: System, supervisorId: string, memberId: string): System {
  if (supervisorId === memberId) throw new SystemError('Canvas: an agent cannot supervise itself');
  const sup = requireAgent(input, supervisorId, 'supervisor');
  requireAgent(input, memberId, 'member');
  if (input.edges.some((e) => e.from === supervisorId && e.to === memberId && e.type === 'supervise')) {
    throw new SystemError(`Canvas: '${supervisorId}' already supervises '${memberId}'`);
  }
  const sys = structuredClone(input);
  const s = sys.agents.find((a) => a.id === supervisorId)!;
  s.members = [...(s.members ?? []), memberId].filter((m, i, arr) => arr.indexOf(m) === i);
  void sup;
  sys.edges.push({ from: supervisorId, to: memberId, type: 'supervise' });
  return sys;
}

/** Wire a guarded handoff Command between two agents. */
export function addHandoffEdge(input: System, from: string, to: string, when?: string): System {
  if (from === to) throw new SystemError('Canvas: an agent cannot hand off to itself');
  requireAgent(input, from, 'handoff source');
  requireAgent(input, to, 'handoff target');
  if (input.edges.some((e) => e.from === from && e.to === to && e.type === 'handoff')) {
    throw new SystemError(`Canvas: '${from}' already hands off to '${to}'`);
  }
  const sys = structuredClone(input);
  const edge = when?.trim()
    ? { from, to, type: 'handoff' as EdgeType, when: when.trim() }
    : { from, to, type: 'handoff' as EdgeType };
  sys.edges.push(edge);
  return sys;
}

/** Remove a specific edge; for a `supervise` edge also drop the membership. */
export function removeEdge(input: System, edge: { from: string; to: string; type: EdgeType }): System {
  const sys = structuredClone(input);
  sys.edges = sys.edges.filter((e) => !(e.from === edge.from && e.to === edge.to && e.type === edge.type));
  if (edge.type === 'supervise') {
    const sup = sys.agents.find((a) => a.id === edge.from);
    if (sup?.members) sup.members = sup.members.filter((m) => m !== edge.to);
  }
  return sys;
}

/** Point the graph entrypoint at a declared agent. */
export function setEntrypoint(input: System, id: string): System {
  if (!input.agents.some((a) => a.id === id)) {
    throw new SystemError(`Canvas: entrypoint '${id}' is not a declared agent`);
  }
  const sys = structuredClone(input);
  sys.entrypoint = id;
  return sys;
}

/**
 * Narrow an agent's tools (Task 6, per-agent narrowing). NARROW-ONLY: the
 * selection must be a subset of the system grants — an agent can never broaden
 * its authority (the compiler enforces this too). Passing the full grant set (or
 * `null`) clears the narrowing so the agent inherits the system grants.
 */
export function setAgentTools(input: System, id: string, tools: string[] | null): System {
  const agent = requireAgent(input, id, 'agent');
  void agent;
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === id)!;
  if (tools === null) {
    delete a.tools;
    return sys;
  }
  const granted = new Set(sys.grants.tools);
  for (const t of tools) {
    if (!granted.has(t)) {
      throw new SystemError(`Canvas: tool '${t}' is not granted to the system (narrow-only)`);
    }
  }
  // Inheriting everything === no narrowing; keep the file clean.
  const narrowed = sys.grants.tools.filter((t) => tools.includes(t));
  if (narrowed.length === sys.grants.tools.length) delete a.tools;
  else a.tools = narrowed;
  return sys;
}

/**
 * Set (or clear) an agent's per-agent LiteLLM `model_name` override (Task 5). An
 * empty/null model clears the override so the agent falls back to activity routing.
 */
export function setAgentModel(input: System, id: string, model: string | null): System {
  requireAgent(input, id, 'agent');
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === id)!;
  if (model && model.trim()) a.model = model.trim();
  else delete a.model;
  return sys;
}
