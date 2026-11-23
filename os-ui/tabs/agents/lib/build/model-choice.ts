/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `model: auto` is decided once per Build: the strong model reads each Auto agent's instructions,
 *             role and tools and picks Strong or Standard, with a one-line reason
 * USER STORY: As a builder I leave an agent on Auto and, when I press Build, see which model it got and why —
 *             and every run until the next Build uses exactly that model.
 * ARCHITECTURE:
 *   - ONE short model call per Build for ALL Auto agents (strong role, low temperature, JSON answer). Agents set to
 *     Strong or Standard are never asked about.
 *   - Deterministic fallback when the call fails or its answer is unusable for an agent: Strong, with a warning the
 *     Build report shows. Nothing is guessed silently.
 *   - The result is written into the definition (`model_resolved`, `model_reason`, `agent-model.ts`) by the caller
 *     (`model-choice-server.ts`), so runs are reproducible and the next Build decides again.
 *   - Pure here: the model call is injected (`LlmCall`), so the real path and the tested path are the same code.
 */
import type { LlmCall } from '@core/runtime/agentic';
import type { AgentSpec, System } from '@tabs/agents/lib/system-schema';
import { MODEL_REASON_MAX, type AgentModelTier } from '@tabs/agents/lib/agent-model';

export type ModelDecision = { id: string; tier: AgentModelTier; reason: string; fallback: boolean };
export type ModelChoiceResult = { decisions: ModelDecision[]; warnings: string[] };

const AGENT_MD_MAX = 1500;

/** The Auto agents of a system (the only ones a Build decides for). */
export function autoAgents(sys: System): AgentSpec[] {
  return sys.agents.filter((a) => a.model === 'auto');
}

/** The prompt: what each Auto agent is for, and the rule for choosing. */
export function modelChoiceMessages(sys: System, agents: AgentSpec[]): { role: 'system' | 'user'; content: string }[] {
  const system = [
    'You choose which model each AI agent of a team runs on. There are two:',
    '- strong: the most capable model. Needed for judgement, planning, multi-step reasoning, writing documents,',
    '  deciding what to change, anything that writes or changes data, and supervising other agents.',
    '- standard: a faster, cheaper model. Enough for reading, looking things up, querying, extracting and',
    '  summarising, and short, direct tasks with clear instructions.',
    'When unsure, choose strong.',
    'Answer with ONLY a JSON object: {"agents":[{"id":"<agent id>","model":"strong"|"standard","reason":"<one short sentence>"}]}',
    'with one entry per agent listed. The reason is plain English for the person who built the team.',
  ].join('\n');
  const tools = (a: AgentSpec) => (a.tools ?? sys.grants.tools);
  const blocks = agents.map((a) => [
    `## Agent: ${a.id}`,
    `Role: ${a.role || '(none)'}`,
    `Tools: ${tools(a).join(', ') || '(none)'}`,
    ...(a.members && a.members.length > 0 ? [`Supervises: ${a.members.join(', ')}`] : []),
    'Instructions:',
    a.agent_md.length > AGENT_MD_MAX ? `${a.agent_md.slice(0, AGENT_MD_MAX)}\n(…cut)` : a.agent_md,
  ].join('\n'));
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Team: ${sys.system.name}\n\n${blocks.join('\n\n')}` },
  ];
}

/** Read the model's answer: the decisions it made for known agents, or null when the answer is not usable at all. */
export function parseModelChoice(text: string, ids: readonly string[]): Map<string, { tier: AgentModelTier; reason: string }> | null {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) return null;
  const out = new Map<string, { tier: AgentModelTier; reason: string }>();
  for (const e of list) {
    const r = e as { id?: unknown; model?: unknown; reason?: unknown };
    if (typeof r.id !== 'string' || !ids.includes(r.id)) continue;
    const m = typeof r.model === 'string' ? r.model.trim().toLowerCase() : '';
    if (m !== 'strong' && m !== 'standard') continue;
    const reason = typeof r.reason === 'string' ? r.reason.replace(/\s+/g, ' ').trim().slice(0, MODEL_REASON_MAX) : '';
    out.set(r.id, { tier: m, reason: reason || (m === 'standard' ? 'reading and lookup work' : 'needs judgement') });
  }
  return out;
}

/**
 * Decide Strong or Standard for every Auto agent with ONE call to `strongModel`. Never throws: a failed call or an
 * unusable answer gives Strong for the agents concerned, each with a warning.
 */
export async function decideAutoModels(sys: System, deps: { llm: LlmCall; strongModel: string }): Promise<ModelChoiceResult> {
  const agents = autoAgents(sys);
  if (agents.length === 0) return { decisions: [], warnings: [] };
  const ids = agents.map((a) => a.id);
  const fallback = (id: string, why: string): ModelDecision => ({ id, tier: 'strong', reason: `Strong by default: ${why}`, fallback: true });
  let answer: Map<string, { tier: AgentModelTier; reason: string }> | null = null;
  let why = '';
  try {
    const completion = await deps.llm({ model: deps.strongModel, messages: modelChoiceMessages(sys, agents), temperature: 0, maxTokens: 120 + 80 * agents.length, purpose: 'agent-model-choice' });
    answer = parseModelChoice(completion.content, ids);
    if (!answer) why = 'the model\'s answer could not be read';
  } catch (e) {
    why = `the model could not be asked (${(e as Error)?.message ?? String(e)})`.slice(0, 160);
  }
  const decisions: ModelDecision[] = [];
  const warnings: string[] = [];
  for (const id of ids) {
    const d = answer?.get(id);
    if (d) {
      decisions.push({ id, tier: d.tier, reason: d.reason, fallback: false });
    } else {
      const reason = why || 'the model gave no choice for this agent';
      decisions.push(fallback(id, reason));
      warnings.push(`Auto model for '${id}': ${reason} — it runs on Strong.`);
    }
  }
  return { decisions, warnings };
}

/** The definition with the decisions written in (only agents still on Auto are changed). */
export function applyModelDecisions(sys: System, decisions: readonly ModelDecision[]): System {
  const next = structuredClone(sys);
  for (const d of decisions) {
    const a = next.agents.find((x) => x.id === d.id);
    if (!a || a.model !== 'auto') continue;
    a.model_resolved = d.tier;
    a.model_reason = d.reason.slice(0, MODEL_REASON_MAX);
  }
  return next;
}
