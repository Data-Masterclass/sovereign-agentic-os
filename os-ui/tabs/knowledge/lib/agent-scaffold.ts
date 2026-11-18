/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    Workflow → agent-system scaffold: one agent per Agent ACTOR, briefed by its steps
 * USER STORY: As a process owner I hand my workflow to the Agents tab and get one agent per actor
 *             that IS an agent, carrying the long prompt I wrote plus the steps I assigned to it.
 * ARCHITECTURE:
 *   - The ACTOR is the unit of agency. `planAgents` (`lib/actor-prompt.ts`) folds every step of an
 *     Agent actor into ONE agent whose `agent_md` is `actorAgentMd(workflow, actor)`; a step whose
 *     actor is not an Agent keeps the per-step AUGMENT / AUTOMATE / MANUAL choice and, when chosen,
 *     becomes its own agent with the older `stepAgentMd` brief.
 *   - We never auto-create: this builds the proposed `system.yaml` (reusing the Agents tab's System
 *     schema) that the user confirms. Execution lives in the Agents tab; Knowledge hands off a design.
 *   - The whole workflow is attached as governed context through `grants.knowledge`, so the granted
 *     `retrieve` tool serves its units at run time rather than the prompt carrying everything.
 *   - This module is the ONE place on this path that imports `@tabs/agents/lib/system-schema` (a
 *     baselined TAB-ISOLATION entry); the pure prompt/plan half lives in `lib/actor-prompt.ts` so
 *     the editor can render the same bytes without that import.
 */
import { type Workflow, type WorkflowStep } from '@tabs/knowledge/lib/schema';
import { type System, type AgentSpec, type Edge, serializeSystem } from '@tabs/agents/lib/system-schema';
import {
  actorAgentMd,
  defaultDisposition,
  planAgents,
  type Disposition,
} from '@tabs/knowledge/lib/actor-prompt';

// Re-exported so the route, the handover panel and the existing tests keep one import site
// for the disposition vocabulary even though it now lives with the plan.
export { defaultDisposition };
export type { Disposition };

/** The older per-STEP brief: a step the author chose to augment or automate itself. */
function stepAgentMd(workflow: Workflow, step: WorkflowStep, disp: Disposition): string {
  const hardRules = [
    ...workflow.rules.filter((r) => r.hard && (r.scope === 'workflow' || r.step_id === step.id)),
    ...step.rules.filter((r) => r.hard),
  ];
  const lines = [
    `# ${step.title}`,
    '',
    `You ${disp === 'automate' ? 'AUTOMATE' : 'ASSIST a human with'} this step of the "${workflow.title}" workflow.`,
    `Original actor: ${step.actor}${step.actor_name ? ` (${step.actor_name})` : ''}.`,
    '',
    step.inputs.length ? `Inputs: ${step.inputs.join(', ')}.` : '',
    step.outputs.length ? `Outputs: ${step.outputs.join(', ')}.` : '',
    step.links.length ? `Linked entities: ${step.links.map((l) => `${l.type}:${l.label || l.ref}`).join(', ')}.` : '',
    '',
    'Use the granted, governed `retrieve` tool to pull the workflow steps, tacit notes and rules as needed.',
  ];
  if (hardRules.length) {
    lines.push('', 'ENFORCED HARD RULES (do not violate):');
    for (const r of hardRules) lines.push(`- ${r.text}`);
  }
  return lines.filter((l) => l !== '').join('\n');
}

export type ScaffoldResult = {
  system: System;
  yaml: string;
  /** Agents built from an Agent ACTOR, with the steps each one owns (for the preview UI). */
  actorAgents: { actorId: string; agentId: string; actorName: string; stepIds: string[] }[];
  /** Agents built from a SINGLE step: an augmented/automated non-Agent step, or an orphan Agent step. */
  agentSteps: { stepId: string; agentId: string; title: string; disposition: Disposition }[];
  /** Steps left as human/software handoffs. */
  manualSteps: { stepId: string; title: string; actor: string }[];
};

/**
 * Build the scaffold. `dispositions` overrides the per-step default. A supervisor routes
 * the agents in workflow order (sequential handoffs); a single agent needs no supervisor,
 * and a workflow with no agent at all gets a coordinator that holds the workflow context.
 */
export function scaffoldSystem(
  workflow: Workflow,
  opts: { dispositions?: Record<string, Disposition>; name?: string } = {},
): ScaffoldResult {
  const plan = planAgents(workflow, opts.dispositions ?? {});

  const agents: AgentSpec[] = [];
  const edges: Edge[] = [];

  /** Every agent of the plan, as a spec, in workflow order. */
  const specById = new Map<string, AgentSpec>();
  for (const a of plan.actorAgents) {
    specById.set(a.agentId, {
      id: a.agentId,
      role: `${a.actor.name} — the Agent actor in ${workflow.title}`,
      agent_md: actorAgentMd(workflow, a.actor),
      memory_md: '',
      tools: ['retrieve'],
    });
  }
  for (const s of plan.stepAgents) {
    specById.set(s.agentId, {
      id: s.agentId,
      role: `${s.disposition === 'automate' ? 'Automates' : 'Assists'}: ${s.step.title}`,
      agent_md: stepAgentMd(workflow, s.step, s.disposition),
      memory_md: '',
      tools: ['retrieve'],
    });
  }
  const members = plan.order.map((o) => ({ spec: specById.get(o.agentId)!, title: o.title }));

  let entrypoint: string;

  if (members.length === 0) {
    // No agent at all — scaffold a single coordinator that has the workflow as context so
    // the user can grow it in the Agents tab.
    const coord: AgentSpec = {
      id: 'coordinator',
      role: `Coordinates the ${workflow.title} workflow`,
      agent_md: `# Coordinator\n\nYou coordinate the "${workflow.title}" workflow. All steps are currently human/software handoffs — use the granted \`retrieve\` tool for context.`,
      memory_md: '',
      tools: ['retrieve'],
    };
    agents.push(coord);
    entrypoint = 'coordinator';
  } else if (members.length === 1) {
    agents.push(members[0].spec);
    entrypoint = members[0].spec.id;
  } else {
    // Supervisor routes through the agents in workflow order.
    const supervisor: AgentSpec = {
      id: 'supervisor',
      role: `Runs the ${workflow.title} workflow`,
      agent_md: `# Supervisor\n\nRoute the "${workflow.title}" workflow through its agents in order:\n${members.map((m, i) => `${i + 1}. ${m.title} (${m.spec.id})`).join('\n')}`,
      memory_md: '',
      members: members.map((m) => m.spec.id),
    };
    agents.push(supervisor, ...members.map((m) => m.spec));
    entrypoint = 'supervisor';
    for (let i = 0; i < members.length - 1; i++) {
      edges.push({ from: members[i].spec.id, to: members[i + 1].spec.id, type: 'handoff', when: 'step complete' });
    }
  }

  const system: System = {
    version: '1',
    system: { name: opts.name ?? `${workflow.title} agent`, domain: workflow.domain, visibility: 'Personal' },
    runtime: 'langgraph',
    safetyPreset: 'read-only',
    entrypoint,
    state: { channels: { messages: 'add_messages' } },
    // The whole workflow is attached as governed context via grants.knowledge.
    grants: { data: [], knowledge: [{ id: workflow.id, capability: 'Read' }], metrics: [], tools: ['retrieve'], connections: [], files: [], plan: [] },
    routing: { overrides: {} },
    agents,
    edges,
  };

  return {
    system,
    yaml: serializeSystem(system),
    actorAgents: plan.actorAgents.map((a) => ({
      actorId: a.actor.id ?? '',
      agentId: a.agentId,
      actorName: a.actor.name,
      stepIds: a.steps.map((s) => s.id),
    })),
    agentSteps: plan.stepAgents.map((s) => ({
      stepId: s.step.id,
      agentId: s.agentId,
      title: s.step.title,
      disposition: s.disposition,
    })),
    manualSteps: plan.manualSteps,
  };
}
