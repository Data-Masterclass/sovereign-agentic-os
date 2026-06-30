/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Workflow } from './schema.ts';

/**
 * Pure compile: a workflow's HARD decision rules → OPA guardrails.
 *
 * Locked decision: soft rules stay as prose the agent follows; HARD rules that
 * are structured/checkable compile to OPA guardrails (enforced) AND are pinned in
 * context. This module is the PURE compile step (workflow → policy data + Rego);
 * the apply→verify against OPA (live-try → honest offline mock) lives in
 * `guardrails-apply.ts` (server-only), mirroring the agents Build adapter.
 *
 * A hard rule becomes a named guardrail. Workflow-scope hard rules guard the whole
 * process; step-scope hard rules guard that step (a step's hard rule = that step's
 * agent guardrail).
 */

export type Guardrail = {
  id: string;
  level: 'workflow' | 'step';
  /** Present for step-level guardrails. */
  stepId?: string;
  stepTitle?: string;
  text: string;
};

export type CompiledGuardrails = {
  workflowId: string;
  /** The package path the OPA policy is loaded under. */
  packagePath: string;
  guardrails: Guardrail[];
  /** The OPA policy DATA (what the runtime queries; the structured mirror). */
  data: { guardrails: { id: string; level: string; step_id?: string; text: string }[] };
  /** A readable Rego policy (the enforced default-deny-on-violation stub). */
  rego: string;
};

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Collect every HARD rule (workflow + step scope) as a guardrail. */
export function collectGuardrails(workflow: Workflow): Guardrail[] {
  const out: Guardrail[] = [];

  // Workflow-level hard rules (frontmatter rules with scope workflow).
  for (const r of workflow.rules) {
    if (!r.hard) continue;
    if (r.scope === 'step' && r.step_id) {
      const step = workflow.steps.find((s) => s.id === r.step_id);
      out.push({ id: r.id, level: 'step', stepId: r.step_id, stepTitle: step?.title, text: r.text });
    } else {
      out.push({ id: r.id, level: 'workflow', text: r.text });
    }
  }

  // Step-level hard rules (each step's own rules[]).
  for (const step of workflow.steps) {
    for (const r of step.rules) {
      if (!r.hard) continue;
      out.push({ id: r.id, level: 'step', stepId: step.id, stepTitle: step.title, text: r.text });
    }
  }

  return out;
}

/** Compile a workflow's hard rules into an OPA policy (data + Rego). */
export function compileGuardrails(workflow: Workflow): CompiledGuardrails {
  const guardrails = collectGuardrails(workflow);
  const packagePath = `agentic.knowledge.${safeId(workflow.id)}`;

  const data = {
    guardrails: guardrails.map((g) => ({
      id: g.id,
      level: g.level,
      ...(g.stepId ? { step_id: g.stepId } : {}),
      text: g.text,
    })),
  };

  // Rego: a readable default-deny-on-violation stub. Each hard rule is a named
  // constraint an action must satisfy; `allow` requires no violated guardrail.
  const lines: string[] = [];
  lines.push(`package ${packagePath}`);
  lines.push('');
  lines.push('# Compiled from the workflow\'s HARD decision rules (Knowledge tab).');
  lines.push('# Soft rules are NOT here — they stay as prose guidance for the agent.');
  lines.push('');
  lines.push('default allow := false');
  lines.push('');
  if (guardrails.length === 0) {
    lines.push('# No hard rules → no enforced guardrails (agent follows soft guidance only).');
    lines.push('allow := true');
  } else {
    lines.push('# An action is allowed only when it violates none of these guardrails:');
    for (const g of guardrails) {
      const scopeTag = g.level === 'step' ? `step:${g.stepId}` : 'workflow';
      // Collapse newlines so a multi-line rule can never break the Rego comment.
      const text = g.text.replace(/\s*\n+\s*/g, ' ');
      lines.push(`#   [${scopeTag}] ${text}`);
    }
    lines.push('');
    lines.push('allow if {');
    lines.push('  not violated');
    lines.push('}');
    lines.push('');
    lines.push('violated if {');
    lines.push('  some g in input.violations');
    lines.push('  g in {x | x := data.guardrails[_].id}');
    lines.push('}');
  }

  return { workflowId: workflow.id, packagePath, guardrails, data, rego: lines.join('\n') + '\n' };
}
