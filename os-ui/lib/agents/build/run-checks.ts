/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { DiagRun } from './run-diagnostics.ts';

/**
 * The Evaluate phase's DETERMINISTIC checks — green/red, zero-cost, no model. They
 * read only the run's own data (the same `DiagRun` shape the diagnostics table and
 * PDF consume), so a student sees a truthful pass/fail before any LLM judgment:
 *
 *   1. Output non-empty       — the team actually produced a final answer.
 *   2. No error or denial      — no node failed and no tool step was denied/errored.
 *   3. Within the step budget  — the run did not stop at the tool-step cap.
 *
 * Pure and framework-free so it is trivially unit-testable and can render identically
 * on the server (route) or the client (panel).
 */

export type Check = { id: 'output' | 'clean' | 'budget'; label: string; pass: boolean; detail: string };

/** The step-cap phrasing the run route/adapters use when a node hits the budget. */
const STEP_CAP_RE = /tool[- ]step budget|tool step limit|step limit \(cap\)|reached the step (?:cap|limit)/i;

/** Did the run stop because it hit the per-node tool-step cap? (Read from output text.) */
function hitStepCap(run: DiagRun): boolean {
  return !!run.output && STEP_CAP_RE.test(run.output);
}

/** Count denied (policy) + errored (exec) tool steps across all nodes. */
function badSteps(run: DiagRun): { denied: number; errors: number; failedNode?: string } {
  let denied = 0;
  let errors = 0;
  let failedNode: string | undefined;
  for (const n of run.nodes ?? []) {
    if (n.status === 'failed') failedNode = failedNode ?? n.node;
    for (const s of n.steps) {
      if (!s.isError) continue;
      if (s.errorKind === 'policy') denied += 1;
      else errors += 1;
    }
  }
  return { denied, errors, failedNode };
}

/** Whether the run produced any non-whitespace final output. */
function hasOutput(run: DiagRun): boolean {
  return !!run.output && run.output.trim().length > 0;
}

/** Run the three deterministic checks over a completed run. */
export function runChecks(run: DiagRun): Check[] {
  const out = hasOutput(run);
  const { denied, errors, failedNode } = badSteps(run);
  const clean = denied === 0 && errors === 0 && !failedNode;
  const budget = !hitStepCap(run);

  return [
    {
      id: 'output',
      label: 'Produced an answer',
      pass: out,
      detail: out ? 'The team returned a non-empty final output.' : 'No final output was produced.',
    },
    {
      id: 'clean',
      label: 'No errors or denials',
      pass: clean,
      detail: clean
        ? 'Every agent finished and no tool call was denied or errored.'
        : failedNode
          ? `Agent "${failedNode}" failed during the run.`
          : `${denied} denied · ${errors} errored tool call${denied + errors === 1 ? '' : 's'}.`,
    },
    {
      id: 'budget',
      label: 'Within the step budget',
      pass: budget,
      detail: budget
        ? 'The run completed without hitting the per-agent tool-step cap.'
        : 'The run stopped at the tool-step cap — it may not have finished the task.',
    },
  ];
}

/** All three checks green? A convenience for the summary badge. */
export function allChecksPass(checks: Check[]): boolean {
  return checks.every((c) => c.pass);
}
