/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * PER-AGENT role templates for the Simple builder's Design phase "+ Add agent"
 * picker. Unlike `templates.ts` (which authors a whole starter `system.yaml` on the
 * server), these are tiny client-side building blocks: each returns the plain
 * fields a new agent card needs — {role, instructions, suggestedTools?} — so the UI
 * can add it via the existing `addSimpleAgent(sys, {role, instructions})` and then
 * apply each suggested tool via `addAgentTool(sys, agentId, tool)`. There is NO new
 * data model: the output is ordinary Simple-mode edits to the one `system.yaml`.
 *
 * The role prose mirrors the `SPECS` in `templates.ts` (blank/analyze/evaluate/
 * recommend) so a per-agent card reads the same as a single-agent starter, PLUS a
 * `researcher`. Marketplace-shared agents are a SEPARATE source the picker adds at
 * runtime (copying {role, agent_md} text is ungated) — they are not listed here.
 */

export type AgentTemplateKey = 'blank' | 'analyst' | 'recommender' | 'reviewer' | 'researcher';

export type AgentTemplate = {
  role: string;
  /** The AGENT.md instructions BODY (no leading heading — `addSimpleAgent` adds it). */
  instructions: string;
  /** Deterministic tool suggestions to apply after adding, subject to the role floor. */
  suggestedTools?: string[];
};

export type AgentTemplateDef = {
  key: AgentTemplateKey;
  label: string;
  /** One plain-language line: "choose this when…". */
  blurb: string;
};

/** The picker's curated cards, in display order (blank first). */
export const AGENT_TEMPLATES: AgentTemplateDef[] = [
  { key: 'blank', label: 'Blank', blurb: 'A helpful assistant. Write it yourself.' },
  { key: 'analyst', label: 'Analyst', blurb: 'Reads sources and explains what the data is saying.' },
  { key: 'recommender', label: 'Recommender', blurb: 'Weighs options and proposes a clear next step.' },
  { key: 'reviewer', label: 'Reviewer', blurb: 'Scores something against clear criteria and flags risks.' },
  { key: 'researcher', label: 'Researcher', blurb: 'Digs across knowledge and gathers the facts that matter.' },
];

const TEMPLATE_KEYS = new Set<AgentTemplateKey>(AGENT_TEMPLATES.map((t) => t.key));

export function isAgentTemplateKey(v: unknown): v is AgentTemplateKey {
  return typeof v === 'string' && TEMPLATE_KEYS.has(v as AgentTemplateKey);
}

const TEMPLATES: Record<AgentTemplateKey, AgentTemplate> = {
  blank: {
    role: 'A helpful assistant',
    instructions: 'You are a helpful assistant in the Sovereign Agentic OS.\nUse only your granted, governed tools.',
  },
  analyst: {
    role: 'Analyzes sources and explains the findings',
    instructions:
      'You analyze the material you are given and explain, in plain language, what it means.\n\n' +
      '## How to work\n' +
      '1. Retrieve the relevant sources with your governed tools.\n' +
      '2. Pull out the facts that matter — figures, trends, changes.\n' +
      '3. Explain what they mean and why, without jargon.\n' +
      '4. Note anything uncertain or missing.\n\n' +
      'Be accurate and honest. Never invent numbers.',
    suggestedTools: ['query_data', 'search_knowledge'],
  },
  recommender: {
    role: 'Weighs options and proposes a next step',
    instructions:
      'You weigh the options and propose a clear, actionable recommendation.\n\n' +
      '## How to work\n' +
      '1. Lay out the realistic options.\n' +
      '2. Compare them on the trade-offs that matter.\n' +
      '3. Recommend ONE next step, and say why.\n' +
      '4. Note what would change your mind.\n\n' +
      'Be decisive but transparent about the trade-offs.',
    suggestedTools: ['search_knowledge'],
  },
  reviewer: {
    role: 'Scores against criteria and flags risks',
    instructions:
      'You evaluate something against clear criteria and give a fair, evidence-based verdict.\n\n' +
      '## How to work\n' +
      '1. State the criteria you are judging against.\n' +
      '2. For each one, cite the evidence and give a rating.\n' +
      '3. Flag risks and weak spots explicitly.\n' +
      '4. Finish with an overall verdict and confidence level.\n\n' +
      'Be balanced. Reward strengths, name weaknesses.',
    suggestedTools: ['search_knowledge'],
  },
  researcher: {
    role: 'Researches across knowledge and gathers the facts',
    instructions:
      'You research a question across the knowledge and data the team can reach, and gather the facts that matter.\n\n' +
      '## How to work\n' +
      '1. Break the question into the specific things you need to know.\n' +
      '2. Search the granted knowledge and query the granted data for each.\n' +
      '3. Collect the concrete findings — with where each came from.\n' +
      '4. Summarize what is known, what is missing, and what is still uncertain.\n\n' +
      'Ground every claim in a source. Never fill a gap by guessing.',
    suggestedTools: ['search_knowledge', 'query_data'],
  },
};

/** Resolve a curated per-agent template's plain fields (falls back to blank). */
export function agentTemplate(key: AgentTemplateKey): AgentTemplate {
  return TEMPLATES[key] ?? TEMPLATES.blank;
}
