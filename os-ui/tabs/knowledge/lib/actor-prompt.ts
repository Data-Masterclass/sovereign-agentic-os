/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    An Agent actor's long prompt + its steps compiled into the agent's AGENT.md
 * USER STORY: As a process owner I write one long prompt for an actor that IS an agent, and the
 *             steps I assigned to that actor become the rest of its instructions — so the agent
 *             system built from the workflow has one agent per actor, briefed by the workflow.
 * ARCHITECTURE:
 *   - The ACTOR is the unit of agency, not the step. `planAgents` folds every step of an Agent
 *     actor into ONE agent; a step whose actor is not an Agent keeps the per-step disposition.
 *   - `actorAgentMd(workflow, actor)` is a pure function of those two arguments — deliberately NOT
 *     of the dispositions — which is what lets the editor's preview (`ui/ActorInspector.tsx`) and
 *     the scaffold's output (`lib/agent-scaffold.ts`) be the same bytes. Dispositions decide
 *     WHETHER an agent exists; they never rewrite what it is told.
 *   - This module imports only this tab's `schema` + `actor-registry`. It is deliberately free of
 *     `@tabs/agents/lib/system-schema` (which `agent-scaffold.ts` needs) so a client component can
 *     render the preview without pulling another tab into the browser bundle.
 *   - Soft rules are not in the prompt: hard rules must stay unambiguous.
 */
import type { Actor, Workflow, WorkflowStep } from '@tabs/knowledge/lib/schema';
import { actorForStep, stepsUsingActor } from '@tabs/knowledge/lib/actor-registry';

/** What the author chose for a step in the handover panel. */
export type Disposition = 'manual' | 'augment' | 'automate';

/** Default: an Agent-actor step automates; every other actor stays a manual handoff. */
export function defaultDisposition(step: WorkflowStep): Disposition {
  return step.actor === 'Agent' ? 'automate' : 'manual';
}

function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The agent id for an Agent actor: its NAME slugged, so `system.yaml` reads like the
 * workflow does. Deterministic, because the id lands in the graph's edges and a churning
 * id would rewrite the system on every scaffold. An unsluggable name falls back to the
 * actor's (already stable) id.
 */
export function agentIdForActor(actor: Actor): string {
  const base = slug(actor.name) || slug(actor.id ?? '') || 'agent';
  return /^[a-z]/.test(base) ? base : `agent-${base}`;
}

/** The agent id for a single step (the pre-actor shape, kept for non-Agent dispositions). */
export function agentIdForStep(step: WorkflowStep): string {
  const base = slug(step.id);
  return /^[a-z]/.test(base) ? base : `step-${base || 'x'}`;
}

/** The hard rules that apply to ONE step: its own, plus the workflow rules scoped to it. */
function hardRulesForStep(workflow: Workflow, step: WorkflowStep): string[] {
  return [
    ...step.rules.filter((r) => r.hard).map((r) => r.text),
    ...workflow.rules.filter((r) => r.hard && r.scope === 'step' && r.step_id === step.id).map((r) => r.text),
  ];
}

/** The workflow-wide hard rules (scope `workflow`), which bind every agent. */
function hardWorkflowRules(workflow: Workflow): string[] {
  return workflow.rules.filter((r) => r.hard && r.scope === 'workflow').map((r) => r.text);
}

/** `data:Customer Applications, app:refund-tool` — the step's linked governed entities. */
function linkedEntities(step: WorkflowStep): string {
  return step.links.map((l) => `${l.type}:${l.label || l.ref}`).join(', ');
}

/** The head of the file: the author's prompt verbatim, or a generated stand-in. */
function promptHead(workflow: Workflow, actor: Actor): string {
  const own = actor.prompt?.trim();
  if (own) return own;
  const lines = [`# ${actor.name}`, '', `You are ${actor.name}, an agent in the "${workflow.title}" workflow.`];
  if (actor.description?.trim()) lines.push(actor.description.trim());
  return lines.join('\n');
}

/**
 * The `AGENT.md` for an Agent actor: the actor's long prompt first, verbatim, then the
 * steps it is assigned to — in workflow order, with their inputs, outputs, linked
 * entities, expert-knowledge note and hard rules — then the workflow-wide hard rules.
 *
 * Every step the actor is assigned to is listed, whatever its disposition: the prompt is
 * what the agent is, and the preview in the editor must be able to show it before anyone
 * has chosen a disposition. See the module header.
 */
export function actorAgentMd(workflow: Workflow, actor: Actor): string {
  const steps = stepsUsingActor(workflow, actor);
  const out: string[] = [promptHead(workflow, actor), '', `## Your steps in the ${workflow.title} workflow`];

  if (steps.length === 0) {
    out.push('', 'No steps are assigned to you in this workflow yet.');
  }
  steps.forEach((step, i) => {
    out.push('', `### ${i + 1}. ${step.title}`);
    if (step.inputs.length) out.push(`- Inputs: ${step.inputs.join(', ')}`);
    if (step.outputs.length) out.push(`- Outputs: ${step.outputs.join(', ')}`);
    if (step.links.length) out.push(`- Linked entities: ${linkedEntities(step)}`);
    const tacit = step.tacit.trim();
    if (tacit) {
      const [first, ...rest] = tacit.split('\n');
      out.push(`- Expert knowledge: ${first}`);
      // A continuation line of a markdown list item is indented, or the renderer ends the item.
      for (const line of rest) out.push(`  ${line}`);
    }
    for (const rule of hardRulesForStep(workflow, step)) out.push(`- HARD RULE: ${rule}`);
  });

  const wfRules = hardWorkflowRules(workflow);
  if (wfRules.length) {
    out.push('', `## Hard rules for the whole ${workflow.title} workflow`);
    for (const rule of wfRules) out.push(`- ${rule}`);
  }

  out.push(
    '',
    'Use the granted, governed `retrieve` tool to pull this workflow’s steps, expert-knowledge notes and rules as needed.',
  );
  return out.join('\n');
}

/** One agent per Agent ACTOR, with every step that actor owns. */
export type ActorAgentPlan = { agentId: string; actor: Actor; steps: WorkflowStep[] };

/** One agent for a SINGLE step: an augmented/automated non-Agent step, or an orphan Agent step. */
export type StepAgentPlan = { agentId: string; step: WorkflowStep; disposition: Disposition };

export type AgentPlan = {
  actorAgents: ActorAgentPlan[];
  stepAgents: StepAgentPlan[];
  /** Every agent in workflow order — the order the supervisor routes them in. */
  order: { agentId: string; title: string }[];
  manualSteps: { stepId: string; title: string; actor: string }[];
};

/**
 * Group the workflow's steps into the agents the scaffold should create.
 *
 * One walk, in workflow order:
 *   - disposition `manual`                                  → a manual handoff;
 *   - an `Agent` step whose actor IS in the registry         → folded into that actor's agent,
 *                                                              created the first time it is seen
 *                                                              (which fixes its place in `order`);
 *   - an `Agent` step whose actor is NOT in the registry     → a per-step agent. `actorWarnings()`
 *                                                              reports the defect; the scaffold must
 *                                                              not lose the step meanwhile;
 *   - any other actor with `augment`/`automate`              → a per-step agent (the author asked).
 */
export function planAgents(
  workflow: Workflow,
  dispositions: Record<string, Disposition> = {},
): AgentPlan {
  const actorAgents: ActorAgentPlan[] = [];
  const stepAgents: StepAgentPlan[] = [];
  const order: { agentId: string; title: string }[] = [];
  const manualSteps: { stepId: string; title: string; actor: string }[] = [];
  const byActorId = new Map<string, ActorAgentPlan>();
  const taken = new Set<string>();

  const unique = (id: string) => {
    let out = id;
    let n = 2;
    while (taken.has(out)) out = `${id}-${n++}`;
    taken.add(out);
    return out;
  };

  for (const step of workflow.steps) {
    const disp = dispositions[step.id] ?? defaultDisposition(step);
    if (disp === 'manual') {
      manualSteps.push({ stepId: step.id, title: step.title, actor: step.actor });
      continue;
    }
    const actor = step.actor === 'Agent' ? actorForStep(workflow, step) : undefined;
    if (actor) {
      const key = actor.id ?? `${actor.category}:${actor.name}`;
      const existing = byActorId.get(key);
      if (existing) continue; // already represented — its steps come from the registry
      const plan: ActorAgentPlan = {
        agentId: unique(agentIdForActor(actor)),
        actor,
        steps: stepsUsingActor(workflow, actor),
      };
      byActorId.set(key, plan);
      actorAgents.push(plan);
      order.push({ agentId: plan.agentId, title: actor.name });
      continue;
    }
    const plan: StepAgentPlan = { agentId: unique(agentIdForStep(step)), step, disposition: disp };
    stepAgents.push(plan);
    order.push({ agentId: plan.agentId, title: step.title });
  }

  return { actorAgents, stepAgents, order, manualSteps };
}
