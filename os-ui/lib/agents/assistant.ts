/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type AgentSpec, type System, type Edge, SystemError } from './system-schema.ts';

/**
 * The agent-system helper's edit engine (Approach A, dual-mode #2). It turns a
 * natural-language instruction into a STRUCTURED mutation of the same
 * `system.yaml` the canvas + Monaco edit — then the caller writes it through the
 * store and runs the SAME Build orchestrator, so there is no separate code path.
 *
 * It is deterministic and air-gapped on purpose (no live LLM dependency for the
 * validation gate): it recognises the well-defined "add a <role> sub-agent that
 * hands off to <target>" instruction class. CRITICAL safety property: ingested
 * instructions are treated as DATA, never as authority — a synthesised sub-agent
 * is narrowed to a subset of the system's existing grants, so it can never
 * broaden permissions (the compiler enforces this regardless).
 */

export type InstructionResult = { system: System; summary: string };

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** A small role → suggested-tool map, intersected with the system's grants. */
const ROLE_TOOLS: Record<string, string[]> = {
  research: ['retrieve', 'web_fetch'],
  researcher: ['retrieve', 'web_fetch'],
  writer: ['write_file'],
  analyst: ['metrics', 'query'],
  data: ['metrics', 'query'],
};

export function applyInstruction(input: System, instruction: string): InstructionResult {
  const text = instruction.trim();

  // "add a <role> sub-agent [that hands off to <target>]"
  const add = /add (?:a|an)\s+([a-z][\w-]*)\s+(?:sub-?agent|agent)(?:.*?hands?\s+off\s+to\s+(?:the\s+)?([a-z][\w-]*))?/i.exec(text);
  if (add) {
    const system: System = structuredClone(input);
    const roleWord = add[1].toLowerCase();
    const handoffTarget = add[2]?.toLowerCase();

    const taken = new Set(system.agents.map((a) => a.id));
    const newId = uniqueId(slugify(roleWord), taken);

    // Narrow-only: intersect suggested tools with the system grants.
    const suggested = ROLE_TOOLS[roleWord] ?? ['retrieve'];
    const tools = suggested.filter((t) => system.grants.tools.includes(t));

    const agent: AgentSpec = {
      id: newId,
      role: `${roleWord} sub-agent (added by the agent-system helper)`,
      agent_md: `# ${newId}\n\nA ${roleWord} sub-agent. Use only your granted, governed tools.`,
      memory_md: '',
      tools,
    };
    system.agents.push(agent);

    // Attach under the entrypoint supervisor if there is one.
    const supervisor = system.agents.find((a) => a.id === system.entrypoint && a.members);
    if (supervisor) supervisor.members = [...(supervisor.members ?? []), newId];

    // Wire the requested handoff (only to a declared agent).
    if (handoffTarget && system.agents.some((a) => a.id === handoffTarget)) {
      const edge: Edge = { from: newId, to: handoffTarget, type: 'handoff', when: `${roleWord} complete` };
      system.edges.push(edge);
    }

    const summary = `Added a ${roleWord} sub-agent '${newId}'${
      handoffTarget ? ` that hands off to '${handoffTarget}'` : ''
    }${supervisor ? ` under supervisor '${supervisor.id}'` : ''}. Tools: ${tools.join(', ') || '(none)'}.`;
    return { system, summary };
  }

  throw new SystemError(
    `The agent-system helper could not turn that into a system edit. Try: "add a research sub-agent that hands off to the writer".`,
  );
}
