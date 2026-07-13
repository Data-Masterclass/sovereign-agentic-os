/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type AgentSpec, type System, SystemError } from './system-schema.ts';
import { setInstructions } from './agent-md.ts';

/**
 * Pure, immutable `system.yaml` edits for Simple mode (the guided, plain-fields
 * builder for non-coders). These produce a NEW {@link System} the caller commits
 * through the SAME `commitSystem` / file-write path Developer mode uses — so a
 * Simple edit and the equivalent Developer edit yield an IDENTICAL system.yaml.
 * There is no parallel data model; everything here is an ordinary edit to the one
 * source of truth. Deep semantics (narrow-only tools, dangling edges) stay in the
 * compiler.
 *
 * Every function `structuredClone`s its input and never mutates it, mirroring the
 * contract of `canvas-edit.ts` (Developer mode's mutators), so undo/redo snapshots
 * stay valid across a mode toggle.
 */

/** Set an agent's plain "role" (its one-line description). */
export function setAgentRole(input: System, id: string, role: string): System {
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === id);
  if (!a) throw new SystemError(`Simple: '${id}' is not a declared agent`);
  a.role = role;
  return sys;
}

/**
 * Set an agent's plain "Instructions" — mapped losslessly to the AGENT.md body via
 * {@link setInstructions}, keeping any leading `# Title` heading. This writes the
 * exact same `agents[].agent_md` (projected to `agents/<id>/AGENT.md`) that
 * Developer mode's Monaco editor writes, so the round-trip is byte-identical.
 */
export function setAgentInstructions(input: System, id: string, instructions: string): System {
  const sys = structuredClone(input);
  const a = sys.agents.find((x) => x.id === id);
  if (!a) throw new SystemError(`Simple: '${id}' is not a declared agent`);
  a.agent_md = setInstructions(a.agent_md ?? '', instructions);
  return sys;
}

/**
 * Set the SYSTEM tool grants — the same `grants.tools` list Developer mode's Grants
 * panel writes (dedup, stable order preserved by insertion). Simple mode's
 * accept/toggle chips call this. Narrow-only + role floors are enforced downstream
 * by the compiler and the server SAVE guard, exactly as for the Grants panel.
 */
export function setSystemTools(input: System, tools: string[]): System {
  const sys = structuredClone(input);
  const seen = new Set<string>();
  sys.grants.tools = tools.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return sys;
}

/** Add a tool to the system grants (idempotent). */
export function addSystemTool(input: System, tool: string): System {
  const sys = structuredClone(input);
  if (!sys.grants.tools.includes(tool)) sys.grants.tools.push(tool);
  return sys;
}

/** Remove a tool from the system grants (and from any per-agent narrowing). */
export function removeSystemTool(input: System, tool: string): System {
  const sys = structuredClone(input);
  sys.grants.tools = sys.grants.tools.filter((t) => t !== tool);
  for (const a of sys.agents) {
    if (a.tools) {
      a.tools = a.tools.filter((t) => t !== tool);
    }
  }
  return sys;
}

/**
 * PER-AGENT tools for Simple mode. Each agent card reads "Tools THIS agent can
 * use", so add/remove must affect ONLY the clicked agent — not every sibling. The
 * fix for the bug where a tool added to one agent showed up on a different (the
 * first, inheriting) agent: an agent with no explicit `tools` INHERITS the whole
 * system pool, so any tool added to the pool appeared on it. Here we FREEZE every
 * currently-inheriting agent to its present effective set first, making each
 * agent's tool list explicit and independent, then edit only the target. The OS
 * invariant (an agent's tools ⊆ `grants.tools`) is preserved: the pool is the union.
 */
function freezeInheritedTools(sys: System): void {
  for (const a of sys.agents) if (!a.tools) a.tools = [...sys.grants.tools];
}

/** Grant a tool to ONE agent (idempotent). Other agents are unaffected. */
export function addAgentTool(input: System, agentId: string, tool: string): System {
  const sys = structuredClone(input);
  const target = sys.agents.find((a) => a.id === agentId);
  if (!target) throw new SystemError(`Simple: '${agentId}' is not a declared agent`);
  freezeInheritedTools(sys); // snapshot siblings BEFORE the pool grows
  if (!sys.grants.tools.includes(tool)) sys.grants.tools.push(tool); // keep pool ⊇ union
  target.tools = target.tools!.includes(tool) ? target.tools : [...target.tools!, tool];
  return sys;
}

/** Remove a tool from ONE agent; prune it from the pool if no agent uses it. */
export function removeAgentTool(input: System, agentId: string, tool: string): System {
  const sys = structuredClone(input);
  const target = sys.agents.find((a) => a.id === agentId);
  if (!target) throw new SystemError(`Simple: '${agentId}' is not a declared agent`);
  freezeInheritedTools(sys);
  target.tools = target.tools!.filter((t) => t !== tool);
  if (!sys.agents.some((a) => (a.tools ?? sys.grants.tools).includes(tool))) {
    sys.grants.tools = sys.grants.tools.filter((t) => t !== tool);
  }
  return sys;
}

/**
 * Simple-mode artifact grants — the plain "what your team can use" chips for Data
 * and Knowledge. These write the SAME `grants.data` / `grants.knowledge` list the
 * Developer Grants panel writes, so a Simple grant and the Developer equivalent
 * produce an identical `system.yaml`. Simple only ever grants `Read` (the common
 * consume case); Write capabilities stay in Developer mode. Role floors + save
 * guards are enforced downstream exactly as for the Grants panel.
 */
export function addArtifactGrant(input: System, field: 'data' | 'knowledge', id: string): System {
  const sys = structuredClone(input);
  const arr = sys.grants[field];
  if (!arr.some((g) => g.id === id)) arr.push({ id, capability: 'Read' });
  return sys;
}

/** Remove a Data/Knowledge grant (idempotent). */
export function removeArtifactGrant(input: System, field: 'data' | 'knowledge', id: string): System {
  const sys = structuredClone(input);
  sys.grants[field] = sys.grants[field].filter((g) => g.id !== id);
  return sys;
}

/** Next free `agentN` id (matches Developer mode's canvas guided-add naming). */
export function nextAgentId(sys: System): string {
  const ids = new Set(sys.agents.map((a) => a.id));
  let n = sys.agents.length + 1;
  let id = `agent${n}`;
  while (ids.has(id)) { n += 1; id = `agent${n}`; }
  return id;
}

/**
 * Add a fresh agent from plain fields (role + instructions). The FIRST agent
 * auto-becomes the START entrypoint so a new system compiles at once — the same
 * rule Developer mode's `addAgentGuided` applies. If no instructions are given, a
 * sensible heading+stub is used (matching the canvas `addAgent` default shape).
 */
export function addSimpleAgent(
  input: System,
  opts: { id?: string; role?: string; instructions?: string },
): System {
  const sys = structuredClone(input);
  const id = (opts.id?.trim() || nextAgentId(sys));
  if (!/^[a-z][\w-]*$/i.test(id)) {
    throw new SystemError(`Simple: '${id}' is not a valid agent id (letters, digits, - and _; must start with a letter)`);
  }
  if (sys.agents.some((a) => a.id === id)) {
    throw new SystemError(`Simple: an agent '${id}' already exists`);
  }
  const role = opts.role?.trim() || 'A helpful assistant';
  const body = opts.instructions?.trim()
    ? opts.instructions.trim()
    : `A ${role.toLowerCase()} in the Sovereign Agentic OS.\nUse only your granted, governed tools.`;
  const agent: AgentSpec = {
    id,
    role,
    agent_md: `# ${id}\n\n${body}`,
    memory_md: `# Memory\n\n(Durable facts ${id} should always know.)`,
  };
  sys.agents.push(agent);
  if (!sys.entrypoint) sys.entrypoint = id;
  return sys;
}

/**
 * Remove ANY agent in Simple mode — including the START agent. The raw canvas
 * `removeAgent` refuses to drop the entrypoint; here, if the removed agent IS the
 * entrypoint, we first hand START to the next remaining agent (or clear it when the
 * team becomes empty), so a business user is never stuck unable to delete a card.
 * Also scrubs the agent from every supervisor `members` list + all edges.
 */
export function removeAgentSimple(input: System, agentId: string): System {
  const sys = structuredClone(input);
  if (!sys.agents.some((a) => a.id === agentId)) {
    throw new SystemError(`Simple: '${agentId}' is not a declared agent`);
  }
  if (sys.entrypoint === agentId) {
    const next = sys.agents.find((a) => a.id !== agentId);
    sys.entrypoint = next ? next.id : '';
  }
  sys.agents = sys.agents.filter((a) => a.id !== agentId);
  for (const a of sys.agents) {
    if (a.members) a.members = a.members.filter((m) => m !== agentId);
  }
  sys.edges = sys.edges.filter((e) => e.from !== agentId && e.to !== agentId);
  return sys;
}

/**
 * Move an agent up/down in the declared order (presentation of the guided list).
 * The declared order is meaningful only as the fallback run order; reordering never
 * changes edges/entrypoint. Clamped — a no-op at the ends.
 */
export function moveAgent(input: System, id: string, dir: -1 | 1): System {
  const sys = structuredClone(input);
  const i = sys.agents.findIndex((a) => a.id === id);
  if (i < 0) throw new SystemError(`Simple: '${id}' is not a declared agent`);
  const j = i + dir;
  if (j < 0 || j >= sys.agents.length) return sys; // clamp: no-op at the ends
  const [a] = sys.agents.splice(i, 1);
  sys.agents.splice(j, 0, a);
  return sys;
}
