/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Workflow, type WorkflowRule, KnowledgeError } from './schema.ts';

/**
 * Pure, immutable WORKFLOW-LEVEL decision-rule mutations (the step-level rules
 * live in `step-edit.ts`). Rules are SOFT by default (markdown guidance the agent
 * follows) and can be marked HARD (an enforced guardrail). These edit the
 * `workflow.rules[]` (scope: 'workflow') in `workflow.md`'s frontmatter.
 *
 * Every mutation `structuredClone`s its input (never mutates).
 */

/** Add a workflow-level decision rule (soft by default). */
export function addWorkflowRule(input: Workflow, opts: { text: string; hard?: boolean }): Workflow {
  if (!opts.text.trim()) throw new KnowledgeError('A rule needs text');
  const w = structuredClone(input);
  const rid = `wr-${w.rules.length + 1}-${Math.random().toString(36).slice(2, 5)}`;
  const rule: WorkflowRule = {
    id: rid,
    text: opts.text.trim(),
    hard: Boolean(opts.hard),
    scope: 'workflow',
  };
  w.rules.push(rule);
  return w;
}

/** Toggle a workflow-level rule between soft and hard. */
export function setWorkflowRuleHard(input: Workflow, ruleId: string, hard: boolean): Workflow {
  const w = structuredClone(input);
  const r = w.rules.find((x) => x.id === ruleId && x.scope === 'workflow');
  if (!r) throw new KnowledgeError(`Workflow rule '${ruleId}' not found`);
  r.hard = hard;
  return w;
}

/** Remove a workflow-level rule. */
export function removeWorkflowRule(input: Workflow, ruleId: string): Workflow {
  const w = structuredClone(input);
  w.rules = w.rules.filter((r) => !(r.id === ruleId && r.scope === 'workflow'));
  return w;
}
