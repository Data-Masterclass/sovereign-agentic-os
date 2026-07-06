/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Workflow, type WorkflowStep } from './schema.ts';
import { type System, type AgentSpec, type Edge, serializeSystem } from '../agents/system-schema.ts';

/**
 * Pure workflow → agent-system SCAFFOLD (handover to the Agents tab). The locked
 * design: from a workflow's steps we SUGGEST a graph scaffold and let the user
 * choose, per step, to AUGMENT (agent-assisted) or AUTOMATE (agent-run) it — the
 * rest stay MANUAL human/software handoffs. We never auto-create; this just builds
 * the proposed `system.yaml` (reusing the Agents tab's System schema) that the user
 * confirms. Execution lives in the Agents tab; Knowledge only hands off the design.
 *
 * The general domain knowledge is base context for every domain agent; the whole
 * workflow is attached as context via the system's `grants.knowledge` (the
 * `retrieve`/`knowledge` tool then serves its units, governed). Pinned hard rules
 * are surfaced verbatim in each agent's AGENT.md.
 */

export type Disposition = 'manual' | 'augment' | 'automate';

/** Default: Agent-actor steps automate; Human/Software steps stay manual. */
export function defaultDisposition(step: WorkflowStep): Disposition {
  return step.actor === 'Agent' ? 'automate' : 'manual';
}

function agentId(stepId: string): string {
  const clean = stepId.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return /^[a-z]/.test(clean) ? clean : `step-${clean || 'x'}`;
}

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
  /** Steps that became agents, with their disposition (for the preview UI). */
  agentSteps: { stepId: string; agentId: string; title: string; disposition: Disposition }[];
  /** Steps left as human/software handoffs. */
  manualSteps: { stepId: string; title: string; actor: string }[];
};

/**
 * Build the scaffold. `dispositions` overrides the per-step default; any step set
 * to augment/automate becomes an agent node. A supervisor routes the agent nodes
 * in workflow order (sequential handoffs); a single agent needs no supervisor.
 */
export function scaffoldSystem(
  workflow: Workflow,
  opts: { dispositions?: Record<string, Disposition>; name?: string } = {},
): ScaffoldResult {
  const dispositions = opts.dispositions ?? {};
  const chosen = workflow.steps.map((s) => ({
    step: s,
    disp: dispositions[s.id] ?? defaultDisposition(s),
  }));

  const agentSteps = chosen.filter((c) => c.disp !== 'manual');
  const manualSteps = chosen
    .filter((c) => c.disp === 'manual')
    .map((c) => ({ stepId: c.step.id, title: c.step.title, actor: c.step.actor }));

  const agents: AgentSpec[] = [];
  const edges: Edge[] = [];

  const memberAgents = agentSteps.map(({ step, disp }) => {
    const id = agentId(step.id);
    const spec: AgentSpec = {
      id,
      role: `${disp === 'automate' ? 'Automates' : 'Assists'}: ${step.title}`,
      agent_md: stepAgentMd(workflow, step, disp),
      memory_md: '',
      tools: ['retrieve'],
    };
    return { spec, stepId: step.id, title: step.title, disposition: disp };
  });

  let entrypoint: string;

  if (memberAgents.length === 0) {
    // No agentified steps — scaffold a single coordinator that has the workflow
    // as context so the user can grow it in the Agents tab.
    const coord: AgentSpec = {
      id: 'coordinator',
      role: `Coordinates the ${workflow.title} workflow`,
      agent_md: `# Coordinator\n\nYou coordinate the "${workflow.title}" workflow. All steps are currently human/software handoffs — use the granted \`retrieve\` tool for context.`,
      memory_md: '',
      tools: ['retrieve'],
    };
    agents.push(coord);
    entrypoint = 'coordinator';
  } else if (memberAgents.length === 1) {
    agents.push(memberAgents[0].spec);
    entrypoint = memberAgents[0].spec.id;
  } else {
    // Supervisor routes through the agent steps in workflow order.
    const supervisor: AgentSpec = {
      id: 'supervisor',
      role: `Runs the ${workflow.title} workflow`,
      agent_md: `# Supervisor\n\nRoute the "${workflow.title}" workflow through its steps in order:\n${memberAgents.map((m, i) => `${i + 1}. ${m.title} (${m.spec.id})`).join('\n')}`,
      memory_md: '',
      members: memberAgents.map((m) => m.spec.id),
    };
    agents.push(supervisor, ...memberAgents.map((m) => m.spec));
    entrypoint = 'supervisor';
    // Sequential handoffs between consecutive agent steps.
    for (let i = 0; i < memberAgents.length - 1; i++) {
      edges.push({ from: memberAgents[i].spec.id, to: memberAgents[i + 1].spec.id, type: 'handoff', when: 'step complete' });
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
    grants: { data: [], knowledge: [{ id: workflow.id, capability: 'Read' }], metrics: [], tools: ['retrieve'], connections: [] },
    routing: { overrides: {} },
    agents,
    edges,
  };

  return {
    system,
    yaml: serializeSystem(system),
    agentSteps: memberAgents.map((m) => ({ stepId: m.stepId, agentId: m.spec.id, title: m.title, disposition: m.disposition })),
    manualSteps,
  };
}
