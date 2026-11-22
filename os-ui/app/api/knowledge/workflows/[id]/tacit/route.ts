/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getTacit, getWorkflow, updateTacit } from '@tabs/knowledge/lib/store';
import { authorize, workflowWriteTestGate, workflowWriteDecision, workflowFacts, type WorkflowOp, type WorkflowFacts } from '@core/infra/governed';
import type { CurrentUser } from '@core/kernel/auth';

export const dynamic = 'force-dynamic';

/** OPA door (`agentic.authz.workflow_write`), asked before the store is touched. Fail-closed: no answer = no. */
async function gate(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<void> {
  const seam = workflowWriteTestGate();
  const ok = seam ? Boolean(await seam(op, user, wf)) : (await authorize(`user:${user.id}`, 'workflow.write', workflowWriteDecision(user, op, wf))).allowed;
  if (!ok) throw Object.assign(new Error(`This workflow change was refused by policy (${op}) — the policy engine did not allow it, or did not answer. Nothing was changed.`), { status: 403 });
}

/** GET → the workflow's sibling tacit.md. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    return NextResponse.json(getTacit(id, user));
}, { defaultStatus: 500 });

/** PUT → replace the workflow's tacit.md (knowledge-agent-compressed markdown). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PUT = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
    const { id } = params;
    const tacit = typeof body.tacit === 'string' ? body.tacit : '';
    await gate(user, 'update', workflowFacts(getWorkflow(id, user)));
    const rec = updateTacit(id, user, tacit);
    return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
}, { parse: true, defaultStatus: 500 });
