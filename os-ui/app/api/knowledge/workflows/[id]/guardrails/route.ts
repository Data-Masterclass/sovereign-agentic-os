/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import { codedError } from '@core/kernel/server-message';
import { getWorkflow } from '@tabs/knowledge/lib/store';
import { compileGuardrails } from '@tabs/knowledge/lib/guardrails';
import { applyGuardrails } from '@tabs/knowledge/lib/guardrails-apply';
import { verifyGuardrails } from '@tabs/knowledge/lib/guardrails-data';
import { config } from '@core/kernel/config';
import { roleAtLeast } from '@core/kernel/session';
import { authorize, workflowWriteTestGate, workflowWriteDecision, workflowFacts, type WorkflowOp, type WorkflowFacts } from '@core/infra/governed';
import type { CurrentUser } from '@core/kernel/auth';

export const dynamic = 'force-dynamic';

/** OPA door (`agentic.authz.workflow_write`). Fail-closed: no answer = no. */
async function ask(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<boolean> {
  const seam = workflowWriteTestGate();
  if (seam) return Boolean(await seam(op, user, wf));
  return (await authorize(`user:${user.id}`, 'workflow.write', workflowWriteDecision(user, op, wf))).allowed;
}

async function gate(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<void> {
  if (!(await ask(user, op, wf))) throw codedError(403, `Applying guardrails was refused by policy (${op}) — the policy engine did not allow it, or did not answer. Nothing was changed.`, 'workflows.guardrailsPolicyRefused', { op });
}

/** GET → preview the compiled guardrails (hard rules → OPA) without applying. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
    return NextResponse.json(compileGuardrails(view.workflow));
}, { defaultStatus: 500 });

/**
 * POST → check that OPA enforces the workflow's hard-rule guardrails. A row is ✓ only when OPA
 * answers with them; an unreachable OPA is a failure (no fallback).
 *   - `OS_GUARDRAILS_DATA` on (WP-30): nothing is uploaded — the committed guardrails.json reaches
 *     OPA in the os-data bundle; this verifies OPA has them active.
 *   - off (interim): upload the generated module + data, then verify.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    // Edit-scoped: applying a policy is an edit-level action, not a view.
    const view = getWorkflow(id, user);
    if (view.owner !== user.id && !roleAtLeast(user.role, 'builder')) {
      return apiError(403, 'Not permitted to apply guardrails for this workflow', 'workflows.guardrailsNotPermitted');
    }
    await gate(user, 'update', workflowFacts(view)); // pushing a workflow's policy to OPA is an edit of it
    const result = config.guardrailsData ? await verifyGuardrails(view.workflow) : await applyGuardrails(view.workflow);
    return NextResponse.json(result);
}, { defaultStatus: 500 });
