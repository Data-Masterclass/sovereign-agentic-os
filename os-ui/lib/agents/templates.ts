/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type System, type Visibility, serializeSystem } from './system-schema.ts';

/**
 * Server-authored starter templates for a new agent system. These are the ONLY
 * way a canned `system.yaml` enters the store — the API never accepts arbitrary
 * client yaml, so a template can't smuggle in broader grants or a non-Personal
 * visibility. Each is a single-agent starter tuned for a common Agentic-Leader-
 * Program task, so a non-technical builder starts from something useful, not a
 * blank canvas. All are read-only + Personal; the builder narrows/extends from there.
 */

export type TemplateKey = 'blank' | 'analyze' | 'evaluate' | 'recommend';

export type TemplateDef = {
  key: TemplateKey;
  label: string;
  /** One plain-language line: "choose this when…". */
  blurb: string;
};

export const TEMPLATES: TemplateDef[] = [
  { key: 'blank', label: 'Start blank', blurb: 'A single helpful assistant. Build it up yourself.' },
  { key: 'analyze', label: 'Analyze', blurb: 'Reads sources and explains what the data is saying.' },
  { key: 'evaluate', label: 'Evaluate', blurb: 'Scores something against clear criteria and flags risks.' },
  { key: 'recommend', label: 'Recommend', blurb: 'Weighs options and proposes a clear next step.' },
];

const TEMPLATE_KEYS = new Set<TemplateKey>(TEMPLATES.map((t) => t.key));

export function isTemplateKey(v: unknown): v is TemplateKey {
  return typeof v === 'string' && TEMPLATE_KEYS.has(v as TemplateKey);
}

type Spec = { agentId: string; role: string; agentMd: string; memoryMd: string };

const SPECS: Record<TemplateKey, (name: string) => Spec> = {
  blank: (name) => ({
    agentId: 'assistant',
    role: 'A helpful assistant',
    agentMd: `# ${name}\n\nYou are a helpful assistant in the Sovereign Agentic OS.\nUse only your granted, governed tools.`,
    memoryMd: '# Memory\n\n(Durable facts the assistant should always know.)',
  }),
  analyze: (name) => ({
    agentId: 'analyst',
    role: 'Analyzes sources and explains the findings',
    agentMd: `# ${name} — Analyst\n\nYou analyze the material you are given and explain, in plain language, what it means.\n\n## How to work\n1. Retrieve the relevant sources with your governed tools.\n2. Pull out the facts that matter — figures, trends, changes.\n3. Explain what they mean and why, without jargon.\n4. Note anything uncertain or missing.\n\nBe accurate and honest. Never invent numbers.`,
    memoryMd: '# Memory\n\n(What this analyst has learned about the domain and its sources.)',
  }),
  evaluate: (name) => ({
    agentId: 'evaluator',
    role: 'Scores against criteria and flags risks',
    agentMd: `# ${name} — Evaluator\n\nYou evaluate something against clear criteria and give a fair, evidence-based verdict.\n\n## How to work\n1. State the criteria you are judging against.\n2. For each one, cite the evidence and give a rating.\n3. Flag risks and weak spots explicitly.\n4. Finish with an overall verdict and confidence level.\n\nBe balanced. Reward strengths, name weaknesses.`,
    memoryMd: '# Memory\n\n(Criteria, rubrics and past judgments this evaluator should keep.)',
  }),
  recommend: (name) => ({
    agentId: 'advisor',
    role: 'Weighs options and proposes a next step',
    agentMd: `# ${name} — Advisor\n\nYou weigh the options and propose a clear, actionable recommendation.\n\n## How to work\n1. Lay out the realistic options.\n2. Compare them on the trade-offs that matter.\n3. Recommend ONE next step, and say why.\n4. Note what would change your mind.\n\nBe decisive but transparent about the trade-offs.`,
    memoryMd: '# Memory\n\n(Preferences, constraints and prior decisions to respect.)',
  }),
};

/** Build a starter `system.yaml` for a template, tuned to the system name/domain. */
export function templateYaml(key: TemplateKey, name: string, domain: string, visibility: Visibility = 'Personal'): string {
  const spec = (SPECS[key] ?? SPECS.blank)(name);
  const sys: System = {
    version: '1',
    system: { name, domain, visibility },
    runtime: 'langgraph',
    safetyPreset: 'read-only',
    entrypoint: spec.agentId,
    state: { channels: { messages: 'add_messages' } },
    grants: { data: [], knowledge: [], metrics: [], tools: ['search_knowledge'], connections: [], files: [], plan: [] },
    routing: { overrides: {} },
    agents: [
      { id: spec.agentId, role: spec.role, agent_md: spec.agentMd, memory_md: spec.memoryMd, tools: ['search_knowledge'] },
    ],
    edges: [],
  };
  return serializeSystem(sys);
}
