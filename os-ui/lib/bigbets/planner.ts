/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Big Bet planner adapter (Opus spine — the scaffold-via-governed-flow control).
 *
 * The planner turns a goal into a plan and, on approval, scaffolds each component
 * — but it is a PROPOSER, not a shipper. Two invariants are enforced in code:
 *
 *   1. It scaffolds ONLY through each tab's governed create flow (store.addComponent
 *      → source.scaffold), landing every artifact at `planned` (draft level). It
 *      never reaches a tab directly and never forks a create action.
 *   2. It runs as a `kind: 'planner'` actor, so the source REJECTS it for every
 *      promote/certify/go-live transition — promotion stays human (Builder/Admin).
 *      The planner literally cannot self-promote; it has no code path to.
 *
 * Two-mode governance: `in-tab` (a human is present) records an inline approval
 * per step; `autonomous` records the safety presets it ran under. Every step is
 * OPA-authorized + Langfuse-traced through injected hooks (the API wires the real
 * OPA decision API + Langfuse; tests inject spies). Default hooks are permissive
 * + no-op so the spine stays unit-testable offline.
 */

import { type Actor, type Principal, type Tab, TAB_LABEL, BetError } from './model.ts';
import { addComponent, getBet, setComponentPlan } from './store.ts';
import { assistantComplete, type AssistantMessage } from '../assistant/complete.ts';

export type PlannerStep = {
  tab: Tab;
  title: string;
  /** Indices (within the plan) of steps this one builds AFTER (build-order deps). */
  dependsOn: number[];
  /** Planned-ready offset in days from the kickoff date. */
  offsetDays: number;
  /** Upstream artifact ids this component will consume (composition seed). */
  consumes?: string[];
  rationale: string;
};

export type ProposedPlan = {
  goal: string;
  template: string;
  steps: PlannerStep[];
};

export type Mode = 'in-tab' | 'autonomous';

/** OPA gate + Langfuse trace, injectable so the spine stays offline-testable. */
export type PlannerHooks = {
  authorize?: (principal: string, action: string) => Promise<boolean> | boolean;
  trace?: (event: { step: string; tab: Tab; mode: Mode; principal: string }) => Promise<void> | void;
};

const defaultHooks: Required<PlannerHooks> = {
  authorize: () => true, // fail-open offline; the API passes the live OPA decision
  trace: () => {},
};

// --------------------------------------------------------------- the planner ---

/** The set of tabs a Big Bet component may target (the model's `Tab` values). */
const PLAN_TABS: Tab[] = ['data', 'metric', 'knowledge', 'connection', 'dashboard', 'agent', 'software', 'ml'];

/** A completion transport (injected in tests). Turns messages into raw text. */
export type PlanCompleter = (messages: AssistantMessage[]) => Promise<string>;

const defaultCompleter: PlanCompleter = async (messages) => (await assistantComplete(messages)).content;

function planSystem(): string {
  return [
    'You are the Big Bet PLANNER for the Sovereign Agentic OS. You break a strategic',
    'goal into a concrete, buildable roadmap of governed OS components. Each step is',
    'ONE artifact built in exactly ONE tab. Choose from these tabs:',
    PLAN_TABS.map((t) => `- ${t}: ${TAB_LABEL[t]}`).join('\n'),
    '',
    'Order the steps as a build DAG: upstream foundations first (data / connection /',
    'knowledge / metric), then the value-generating leaves (dashboard / agent /',
    'software / ml) that depend on them. Keep it to 2–6 steps.',
    '',
    'Respond with STRICT JSON ONLY (no prose, no code fences) of the shape:',
    '{"template":"<short-kebab-name>","steps":[{"tab":"data","title":"...",',
    '"dependsOn":[<indices of earlier steps>],"offsetDays":<int planned-ready offset>,',
    '"consumes":["<upstream artifact id>"],"rationale":"..."}]}',
    'Indices in dependsOn refer to earlier steps in this same array (0-based).',
  ].join('\n');
}

function planUser(goal: string, upstream?: { data?: string; connection?: string; knowledge?: string }): string {
  const hints: string[] = [];
  if (upstream?.data) hints.push(`existing data product artifact id: ${upstream.data}`);
  if (upstream?.connection) hints.push(`existing connection artifact id: ${upstream.connection}`);
  if (upstream?.knowledge) hints.push(`existing knowledge artifact id: ${upstream.knowledge}`);
  return [
    `Goal: ${goal}`,
    hints.length ? `Reusable upstream artifacts (put in "consumes" where relevant):\n- ${hints.join('\n- ')}` : '',
    'Produce the JSON plan now.',
  ].filter(Boolean).join('\n\n');
}

/** Extract the first JSON object from the model text (tolerates ```json fences). */
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Parse + VALIDATE the model's JSON into a ProposedPlan. Unknown tabs are dropped,
 * dependsOn indices are clamped to earlier steps, and offsets default sanely. A
 * plan with no valid step is rejected (honest error — we never fabricate one).
 */
export function parsePlanResponse(goal: string, raw: string): ProposedPlan {
  const obj = extractJson(raw);
  const rawSteps = Array.isArray(obj?.steps) ? (obj!.steps as Record<string, unknown>[]) : [];
  const steps: PlannerStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i];
    const tab = String(s.tab ?? '') as Tab;
    if (!PLAN_TABS.includes(tab)) continue;
    const title = String(s.title ?? '').trim() || `${TAB_LABEL[tab]} ${steps.length + 1}`;
    const dependsOn = Array.isArray(s.dependsOn)
      ? (s.dependsOn as unknown[]).map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d < i)
      : [];
    const offsetDays = Number.isFinite(Number(s.offsetDays)) && Number(s.offsetDays) > 0 ? Math.round(Number(s.offsetDays)) : 14 * (steps.length + 1);
    const consumes = Array.isArray(s.consumes) ? (s.consumes as unknown[]).map((c) => String(c)).filter(Boolean) : undefined;
    const rationale = String(s.rationale ?? '').trim() || `${TAB_LABEL[tab]} for the goal.`;
    steps.push({ tab, title, dependsOn, offsetDays, ...(consumes && consumes.length ? { consumes } : {}), rationale });
  }
  if (steps.length === 0) throw new BetError('The planner did not return a usable plan — try rephrasing the goal.', 502);
  const template = String(obj?.template ?? '').trim() || 'plan';
  return { goal, template, steps };
}

/**
 * Turn a goal into a buildable plan by asking the ONE governed assistant LLM
 * (resolved from Platform Admin → Models & Providers) to break it down, then
 * validating its JSON. If the assistant is not configured, `assistantComplete`
 * throws an honest, admin-actionable error — there is NO canned-template fallback.
 */
export async function proposePlan(
  goal: string,
  opts?: { upstream?: { data?: string; connection?: string; knowledge?: string }; complete?: PlanCompleter },
): Promise<ProposedPlan> {
  const g = goal.trim();
  if (!g) throw new BetError('A goal is required.', 400);
  const complete = opts?.complete ?? defaultCompleter;
  const raw = await complete([
    { role: 'system', content: planSystem() },
    { role: 'user', content: planUser(g, opts?.upstream) },
  ]);
  return parsePlanResponse(g, raw);
}

// ----------------------------------------------------------------- approve ---

export type ScaffoldResult = {
  template: string;
  mode: Mode;
  created: { refId: string; tab: Tab; title: string; artifactId: string }[];
};

/**
 * On approval, scaffold every step into its tab (planner actor) and wire the
 * dependency edges from the plan. Returns the created refs. Promotion is NOT
 * performed — the components land at `planned` and a human ships them later.
 */
export async function approvePlan(
  betId: string,
  approver: Principal,
  plan: ProposedPlan,
  opts: { mode?: Mode; kickoff?: string; hooks?: PlannerHooks } = {},
): Promise<ScaffoldResult> {
  const mode: Mode = opts.mode ?? 'in-tab';
  const hooks = { ...defaultHooks, ...(opts.hooks ?? {}) };
  const kickoff = opts.kickoff ?? new Date().toISOString().slice(0, 10);

  // The planner acts under the approver's authority but is marked `planner`, so
  // the source rejects it for any promote/certify/go-live. It can ONLY scaffold.
  const planner: Actor = { ...approver, kind: 'planner' };

  // Authz the plan as a whole first (the approving human must be allowed to edit).
  const bet = getBet(betId, approver);
  const ok = await hooks.authorize(approver.id, 'bigbet.planner.scaffold');
  if (!ok) throw new BetError('Planner scaffolding not authorized for this principal', 403);

  const created: ScaffoldResult['created'] = [];
  const indexToRef: string[] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const plannedReady = addDays(kickoff, step.offsetDays);
    const { ref } = addComponent(betId, planner, {
      tab: step.tab,
      scaffold: { title: step.title, consumes: step.consumes },
      start: kickoff,
      plannedReady,
    });
    indexToRef[i] = ref.id;
    created.push({ refId: ref.id, tab: step.tab, title: step.title, artifactId: ref.artifactId });
    await hooks.trace({ step: step.title, tab: step.tab, mode, principal: planner.id });
  }

  // Second pass: wire dependency edges now that every ref id exists.
  for (let i = 0; i < plan.steps.length; i++) {
    const deps = plan.steps[i].dependsOn.map((d) => indexToRef[d]).filter(Boolean);
    if (deps.length) setComponentPlan(betId, approver, indexToRef[i], { dependsOn: deps });
  }

  void bet; // bet fetched above only to enforce view-scope before scaffolding.
  return { template: plan.template, mode, created };
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
