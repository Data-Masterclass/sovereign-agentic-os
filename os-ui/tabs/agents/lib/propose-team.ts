/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  parseProposedAgents,
  scaffoldFromProposal,
  type ScaffoldCompleter,
  type InstructionResult,
} from '@tabs/agents/lib/assistant';
import type { System } from '@tabs/agents/lib/system-schema';

/**
 * GROUNDED TEAM PROPOSER — the auto-team-proposer behind the Agents Design stage's
 * "propose a team" action. It is a GROUNDED SUPERSET of the free-form scaffolder in
 * `assistant.ts` (`scaffoldSystem`): same three-step pipeline —
 *
 *   assistantComplete → parseProposedAgents (validate/repair/cap 8, reject <2)
 *                     → scaffoldFromProposal (deterministic role-floor tool assignment,
 *                       linear handoff wiring, entrypoint)
 *
 * — but the planner prompt is EXTENDED with a CONTEXT block listing the deliverable (the
 * system description), the declared outputs, and the GRANTED resource NAMES (data /
 * knowledge / connections / metrics / plan) plus the granted TOOL POOL. So the proposed
 * roles reference REAL granted assets, never ungranted ones. The context NAMES are
 * resolved by the caller (the route) through the SAME DLS/RLS-scoped grants listers the
 * grants picker uses — this module never touches the caller's whole catalog.
 *
 * It RETURNS the proposed {@link System} WITHOUT persisting it; the client commits it
 * through the existing governed path (the system.yaml write). The LLM call is injected so
 * the unit test is hermetic (no gateway).
 *
 * SAFETY (inherited from `scaffoldFromProposal`): the LLM proposes STRUCTURE only — it
 * never names tools. Tools are derived deterministically per agent by `suggest-tools`,
 * intersected with the caller's role-floor `toolCatalog`, so the scaffold can never grant
 * above the caller's floor and always passes the narrow-only compiler check.
 */

/** A granted resource, named for grounding (never carries content — just id + name). */
export type GroundedResource = { id: string; name: string };

/**
 * The GROUNDING CONTEXT the route resolves from the system's REAL grants + declared
 * outputs (via the same DLS/RLS-scoped listers the grants picker uses). Every list holds
 * only GRANTED assets — the proposer is told to reference these and nothing else.
 */
export type GroundingContext = {
  /** The deliverable — the system description / success criteria (the Define text). */
  description?: string;
  /** Declared outputs: where the team's results are written (kind · name). */
  outputs?: { kind: string; name: string }[];
  /** Granted DATA products, by name. */
  data?: GroundedResource[];
  /** Granted KNOWLEDGE items, by name. */
  knowledge?: GroundedResource[];
  /** Granted CONNECTIONS, by name. */
  connections?: GroundedResource[];
  /** Granted METRICS, by name. */
  metrics?: GroundedResource[];
  /** Granted PLAN items (Operating Model / Pillars / Big Bets), by name. */
  plan?: GroundedResource[];
  /** The granted TOOL POOL — the tool names the system is granted (role-floor bounded). */
  tools?: string[];
};

export type ProposeTeamInput = {
  /** The system to extend (the proposer REPLACES its agents with the new linear team). */
  system: System;
  /** The user's plain-words description of what the team should do. */
  description: string;
  /** The grounding context (granted assets + outputs + deliverable), resolved by the route. */
  context: GroundingContext;
  /** The injected LLM transport (hermetic in tests). */
  complete: ScaffoldCompleter;
  /**
   * The role-floor tool catalog — the tool names the caller may grant. Passed straight to
   * `scaffoldFromProposal` so per-agent tools never exceed the floor. When omitted, the
   * proposer falls back to the system's own granted tool pool (context.tools).
   */
  toolCatalog?: readonly string[];
};

/** The shared team-planner rules (mirrors the private `scaffoldSystemPrompt` in assistant.ts). */
function plannerRules(): string {
  return [
    'You are the TEAM PLANNER for the Sovereign Agentic OS Agents builder. A',
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
    '- GROUND every step in the CONTEXT below: reference ONLY the granted data,',
    '  knowledge, connections, metrics and plan items named there — NEVER invent a',
    '  dataset, metric, connection or document the team was not granted. If a step',
    '  would need an asset that is not granted, say so in that step\'s instruction',
    '  rather than pretending it exists.',
    '',
    'Respond with STRICT JSON ONLY (no prose, no code fences) of the shape:',
    '{"agents":[{"id":"pull-campaign-data","role":"Pulls the raw campaign data",',
    '"instruction":"Query the granted campaign dataset and return the rows for the period."}]}',
  ].join('\n');
}

/** A named-list block ("- Foo\n- Bar") or '' when the list is empty. */
function namedList(label: string, items: GroundedResource[] | undefined): string {
  if (!items || items.length === 0) return '';
  const rows = items.slice(0, 40).map((r) => `- ${r.name}`).join('\n');
  return `${label}:\n${rows}`;
}

/** Build the grounding CONTEXT block prepended to the planner's user turn. */
export function buildContextBlock(ctx: GroundingContext): string {
  const parts: string[] = ['## Context — the team may reference ONLY these granted assets'];
  if (ctx.description && ctx.description.trim()) {
    parts.push(`Deliverable (system goal): ${ctx.description.trim()}`);
  }
  if (ctx.outputs && ctx.outputs.length) {
    parts.push('Declared outputs (where results are stored):\n' + ctx.outputs.map((o) => `- ${o.kind} · ${o.name}`).join('\n'));
  }
  for (const [label, list] of [
    ['Granted data', ctx.data],
    ['Granted knowledge', ctx.knowledge],
    ['Granted connections', ctx.connections],
    ['Granted metrics', ctx.metrics],
    ['Granted plan items', ctx.plan],
  ] as const) {
    const block = namedList(label, list);
    if (block) parts.push(block);
  }
  if (ctx.tools && ctx.tools.length) {
    parts.push(`Granted tool pool (assigned automatically): ${ctx.tools.join(', ')}`);
  }
  const anyAssets =
    (ctx.data?.length ?? 0) + (ctx.knowledge?.length ?? 0) + (ctx.connections?.length ?? 0) +
    (ctx.metrics?.length ?? 0) + (ctx.plan?.length ?? 0);
  if (anyAssets === 0) {
    parts.push('(No governed assets are granted yet — propose the team structure from the goal, and note in each step which asset it will need granted.)');
  }
  return parts.join('\n\n');
}

/**
 * Propose a grounded linear team for `system` from `description`, grounded in the caller's
 * REAL granted context. Runs the SAME validate/repair/scaffold pipeline as the free-form
 * scaffolder; returns the proposed {@link System} WITHOUT persisting it (the route hands it
 * to the client to commit through the governed write). Throws the same honest errors the
 * pipeline does (a <2-agent proposal is rejected as a 502).
 */
export async function proposeTeam(input: ProposeTeamInput): Promise<InstructionResult> {
  const description = input.description.trim();
  if (!description) {
    // Mirror assistant.scaffoldSystem's honest guard.
    const { SystemError } = await import('./system-schema.ts');
    throw new SystemError('A description is required.');
  }
  const contextBlock = buildContextBlock(input.context);
  const userTurn = `${contextBlock}\n\nDescribe the team for: ${description}\n\nProduce the JSON now.`;
  const raw = await input.complete(plannerRules(), userTurn);
  const proposed = parseProposedAgents(raw);
  // Prefer the explicit role-floor catalog; fall back to the system's granted tool pool so
  // tools stay within what the caller may grant even when a catalog isn't threaded.
  const catalog = input.toolCatalog ?? input.context.tools;
  return scaffoldFromProposal(input.system, proposed, catalog);
}
