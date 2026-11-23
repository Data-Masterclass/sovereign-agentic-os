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
import { KnowledgeError, type Workflow, type WorkflowStep } from '@tabs/knowledge/lib/schema';
import { type System, type AgentSpec, type Edge, serializeSystem } from '@tabs/agents/lib/system-schema';
import {
  actorAgentMd,
  defaultDisposition,
  inline,
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
  // EVERY author-supplied value is flattened (`inline`) before it reaches a generated line:
  // a step title carrying a newline used to be able to forge a heading or a rule here.
  const lines = [
    `# ${inline(step.title)}`,
    '',
    `You ${disp === 'automate' ? 'AUTOMATE' : 'ASSIST a human with'} this step of the "${inline(workflow.title)}" workflow.`,
    `Original actor: ${step.actor}${step.actor_name ? ` (${inline(step.actor_name)})` : ''}.`,
    '',
    step.inputs.length ? `Inputs: ${step.inputs.map(inline).join(', ')}.` : '',
    step.outputs.length ? `Outputs: ${step.outputs.map(inline).join(', ')}.` : '',
    step.links.length ? `Linked entities: ${step.links.map((l) => `${inline(l.type)}:${inline(l.label || l.ref)}`).join(', ')}.` : '',
    '',
    'Use the granted, governed `retrieve` tool to pull the workflow steps, tacit notes and rules as needed.',
  ];
  if (hardRules.length) {
    lines.push('', 'ENFORCED HARD RULES (do not violate):');
    for (const r of hardRules) lines.push(`- ${inline(r.text)}`);
  }
  return lines.filter((l) => l !== '').join('\n');
}

/**
 * The scaffold's own validation of the graph it just built: no two agents may share an id.
 *
 * It lives HERE, not in the Agents tab's `parseSystem`: that schema belongs to another tab,
 * and its job is to read a document, not to police this generator. But nothing downstream
 * rejects a duplicate — `members` and `edges` reference agents by id, so two agents called
 * `supervisor` would commit a graph where "route to supervisor" has two answers. The ids
 * come from `planAgents` (which reserves `RESERVED_AGENT_IDS`) plus the node this function's
 * caller injects, and a guard over the final list is the one check that covers both.
 */
export function assertUniqueAgentIds(agents: { id: string }[]): void {
  const seen = new Set<string>();
  for (const a of agents) {
    if (seen.has(a.id)) {
      throw new KnowledgeError(
        `agent-system scaffold: duplicate agent id '${a.id}' — the graph's members and edges would be ambiguous`,
        500,
      );
    }
    seen.add(a.id);
  }
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
      role: `${inline(a.actor.name)} — the Agent actor in ${inline(workflow.title)}`,
      agent_md: actorAgentMd(workflow, a.actor),
      memory_md: '',
      model: 'auto',
    });
  }
  for (const s of plan.stepAgents) {
    specById.set(s.agentId, {
      id: s.agentId,
      role: `${s.disposition === 'automate' ? 'Automates' : 'Assists'}: ${inline(s.step.title)}`,
      agent_md: stepAgentMd(workflow, s.step, s.disposition),
      memory_md: '',
      model: 'auto',
    });
  }
  const members = plan.order.map((o) => ({ spec: specById.get(o.agentId)!, title: o.title }));

  let entrypoint: string;

  if (members.length === 0) {
    // No agent at all — scaffold a single coordinator that has the workflow as context so
    // the user can grow it in the Agents tab.
    const coord: AgentSpec = {
      id: 'coordinator',
      role: `Coordinates the ${inline(workflow.title)} workflow`,
      agent_md: `# Coordinator\n\nYou coordinate the "${inline(workflow.title)}" workflow. All steps are currently human/software handoffs — use the granted \`retrieve\` tool for context.`,
      memory_md: '',
      model: 'auto',
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
      role: `Runs the ${inline(workflow.title)} workflow`,
      // `m.title` is an actor name or a step title — author-supplied, so flattened: one
      // numbered line per agent, and no title can add a routing instruction of its own.
      agent_md: `# Supervisor\n\nRoute the "${inline(workflow.title)}" workflow through its agents in order:\n${members.map((m, i) => `${i + 1}. ${inline(m.title)} (${m.spec.id})`).join('\n')}`,
      memory_md: '',
      model: 'auto',
      members: members.map((m) => m.spec.id),
    };
    agents.push(supervisor, ...members.map((m) => m.spec));
    entrypoint = 'supervisor';
    for (let i = 0; i < members.length - 1; i++) {
      // No `when:` guard — an unguarded handoff is the sequential edge build-graph already treats
      // as unconditional (`h.when === null`). The previous literal 'step complete' was never a
      // valid `when` expression (grammar: channels, booleans, ==/!=, &&/||) and failed every Build
      // of a scaffolded team at "Wiring the graph" (2026-11-18).
      edges.push({ from: members[i].spec.id, to: members[i + 1].spec.id, type: 'handoff' });
    }
  }

  // The graph is only now complete (the supervisor/coordinator node is injected above), so
  // this is the one place the check can see every id it must be unique against.
  assertUniqueAgentIds(agents);

  const system: System = {
    version: '1',
    system: { name: opts.name ?? `${workflow.title} agent`, domain: workflow.domain, visibility: 'Personal' },
    runtime: 'langgraph',
    safetyPreset: 'read-only',
    entrypoint,
    state: { channels: { messages: 'add_messages' } },
    // The whole workflow is attached as governed context via grants.workflows (a workflow is not a
    // knowledge note: it has its own grant kind).
    grants: { data: [], knowledge: [], workflows: [{ id: workflow.id, capability: 'Read' }], metrics: [], tools: ['retrieve'], connections: [], files: [], plan: [] },
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
