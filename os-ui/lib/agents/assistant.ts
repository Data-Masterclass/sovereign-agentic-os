/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type AgentSpec, type System, type Edge, SystemError } from './system-schema.ts';
import { suggestToolNames } from './suggest-tools.ts';

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

/**
 * A small role → suggested-tool map, intersected with the system's grants.
 * All names are canonical OS MCP tool names (from ALL_MCP_TOOLS).
 * Note: `web_fetch` had no MCP equivalent and was removed from research roles.
 */
const ROLE_TOOLS: Record<string, string[]> = {
  research: ['search_knowledge'],
  researcher: ['search_knowledge'],
  writer: ['upload_file'],
  analyst: ['list_metrics', 'query_data'],
  data: ['list_metrics', 'query_data'],
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
    const suggested = ROLE_TOOLS[roleWord] ?? ['search_knowledge'];
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
    const wired = !!handoffTarget && system.agents.some((a) => a.id === handoffTarget);
    if (wired) {
      const edge: Edge = { from: newId, to: handoffTarget!, type: 'handoff', when: `${roleWord} complete` };
      system.edges.push(edge);
    }

    const summary = `Added a ${roleWord} sub-agent '${newId}'${
      wired ? ` that hands off to '${handoffTarget}'` : ''
    }${supervisor ? ` under supervisor '${supervisor.id}'` : ''}. Tools: ${tools.join(', ') || '(none)'}.${
      handoffTarget && !wired ? ` (Requested handoff target '${handoffTarget}' does not exist — not wired.)` : ''
    }`;
    return { system, summary };
  }

  throw new SystemError(
    `The agent-system helper could not turn that into a system edit. Try: "add a research sub-agent that hands off to the writer".`,
  );
}

// =========================================================================
//  Free-form scaffolder (LLM fallback)
// =========================================================================
//
// When a description is NOT one of the well-defined structured phrases above,
// we ask the ONE governed assistant LLM to propose a TEAM STRUCTURE ONLY — a
// short ordered list of agents (id/role + a one-line instruction each) — which
// we validate, repair and turn into a real linear multi-agent system through
// the SAME `System` object the builder commits (system.yaml).
//
// SAFETY: the LLM proposes STRUCTURE, never authority. It cannot name tools.
// Tools are derived deterministically by `suggest-tools` from each agent's own
// role/instruction text, intersected with the caller's role-floor catalog, so
// the scaffold can never grant above the caller's floor. Models stay Auto.
// The result is validated against the compiler's invariants before it is
// returned; a malformed proposal is repaired or rejected — never written.

/** One agent the LLM proposes: a role/name and a single-line instruction. */
export type ProposedAgent = { id: string; role: string; instruction: string };

/** A completion transport (injected in tests). Turns a prompt into raw text. */
export type ScaffoldCompleter = (system: string, user: string) => Promise<string>;

/** Cap the team size so a runaway proposal can't balloon the system. */
const MAX_AGENTS = 8;

function scaffoldSystemPrompt(): string {
  return [
    'You are the TEAM PLANNER for the Sovereign Agentic OS Simple builder. A',
    'non-technical user describes, in plain words, what a team of AI agents should',
    'do. You break that into a short, ordered pipeline of agents where each agent',
    'performs ONE clear step and hands its result to the next.',
    '',
    'Rules:',
    '- Propose 2 to 6 agents (never more than 8). Fewer is better when it fits.',
    '- Order them as a linear pipeline: step 1 → step 2 → ... The first agent starts.',
    '- Each agent gets a short kebab-case id (e.g. "pull-campaign-data"), a one-line',
    '  role, and a one-line instruction telling it exactly what to do in plain words.',
    '- Do NOT mention tools, models, credentials or permissions — only WHAT each',
    '  agent does. The OS assigns tools and models automatically and safely.',
    '',
    'Respond with STRICT JSON ONLY (no prose, no code fences) of the shape:',
    '{"agents":[{"id":"pull-campaign-data","role":"Pulls the raw campaign data",',
    '"instruction":"Query the campaign dataset and return the rows for the period."}]}',
  ].join('\n');
}

/** Extract the first JSON object from model text (tolerates ```json fences). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Parse + VALIDATE + REPAIR the LLM's JSON into an ordered list of proposed
 * agents. Malformed entries are dropped, ids are slugified + de-duplicated, and
 * the list is capped. A proposal with fewer than 2 usable agents is REJECTED
 * (honest error — we never fabricate a team), so a malformed output is never
 * turned into a system.
 */
export function parseProposedAgents(raw: string): ProposedAgent[] {
  const obj = extractJsonObject(raw);
  const rawAgents = Array.isArray(obj?.agents) ? (obj!.agents as unknown[]) : [];
  const out: ProposedAgent[] = [];
  const taken = new Set<string>();
  for (const entry of rawAgents) {
    if (out.length >= MAX_AGENTS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const role = String(e.role ?? '').trim();
    const instruction = String(e.instruction ?? '').trim();
    // A step with neither a role nor an instruction carries no meaning — drop it.
    if (!role && !instruction) continue;
    const base = slugify(String(e.id ?? '') || role || instruction).slice(0, 40) || 'agent';
    const id = uniqueId(base, taken);
    taken.add(id);
    out.push({
      id,
      role: role || 'Performs its step and hands off to the next agent',
      instruction: instruction || role,
    });
  }
  if (out.length < 2) {
    throw new SystemError(
      'The OS could not turn that description into a team yet — try describing the steps more concretely (e.g. "pull the data, check margins, then recommend changes").',
      502,
    );
  }
  return out;
}

/**
 * Turn a validated list of proposed agents into a real, compile-clean linear
 * {@link System}, REPLACING any prior scaffold so describing again does not
 * endlessly append duplicates. Tools are assigned deterministically per agent
 * via `suggest-tools`, intersected with the caller's role-floor `catalog`, and
 * unioned into `grants.tools` (each agent narrowed to its own subset) — so the
 * result stays within the caller's floor AND passes the narrow-only compiler
 * check. Models are left as Auto (no per-agent `model`).
 */
export function scaffoldFromProposal(
  input: System,
  proposed: ProposedAgent[],
  catalog?: readonly string[],
): InstructionResult {
  const system: System = structuredClone(input);

  const agents: AgentSpec[] = [];
  const grantSet = new Set<string>(system.grants.tools);
  for (const p of proposed) {
    const text = `${p.id} ${p.role} ${p.instruction}`;
    // Deterministic, role-floor-bounded tool suggestion — the LLM never names tools.
    const tools = suggestToolNames(text, catalog);
    for (const t of tools) grantSet.add(t);
    agents.push({
      id: p.id,
      role: p.role,
      agent_md: `# ${p.id}\n\n${p.instruction}`,
      memory_md: '',
      tools,
    });
  }

  // Linear chain: each agent hands off to the next; the first is the entrypoint.
  const edges: Edge[] = [];
  for (let i = 0; i < agents.length - 1; i++) {
    edges.push({ from: agents[i].id, to: agents[i + 1].id, type: 'handoff', when: `${agents[i].role} complete` });
  }

  system.agents = agents;
  system.edges = edges;
  system.entrypoint = agents[0].id;
  system.grants = { ...system.grants, tools: [...grantSet] };
  // A scaffold is a fresh linear team — drop any stale positions/routing overrides
  // that referenced the replaced agents so nothing dangles.
  system.routing = { overrides: {} };
  if (system.ui) delete system.ui;

  const summary = `Scaffolded a ${agents.length}-agent team: ${agents.map((a) => a.id).join(' → ')}. Start: '${agents[0].id}'. Tools were auto-suggested per role within your access; review and adjust each agent below.`;
  return { system, summary };
}

/**
 * The free-form scaffold path: ask the governed assistant LLM for a team
 * STRUCTURE, validate/repair it, then apply it through the same `System` write
 * the builder uses. This is the FALLBACK for descriptions the deterministic
 * {@link applyInstruction} fast-path does not recognise.
 */
export async function scaffoldSystem(
  input: System,
  description: string,
  opts: { complete: ScaffoldCompleter; catalog?: readonly string[] },
): Promise<InstructionResult> {
  const desc = description.trim();
  if (!desc) throw new SystemError('A description is required.');
  const raw = await opts.complete(scaffoldSystemPrompt(), `Describe the team for: ${desc}\n\nProduce the JSON now.`);
  const proposed = parseProposedAgents(raw);
  return scaffoldFromProposal(input, proposed, opts.catalog);
}
