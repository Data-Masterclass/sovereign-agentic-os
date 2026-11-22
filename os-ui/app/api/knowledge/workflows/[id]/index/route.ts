/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getWorkflow, getDomainKnowledge } from '@tabs/knowledge/lib/store';
import { indexWorkflow, indexDomain } from '@tabs/knowledge/lib/index-pipeline';
import { actingCaller } from '@tabs/knowledge/lib/embed';
import { authorize, workflowWriteTestGate, workflowWriteDecision, workflowFacts, type WorkflowOp, type WorkflowFacts } from '@core/infra/governed';
import type { CurrentUser } from '@core/kernel/auth';

export const dynamic = 'force-dynamic';

/** OPA door (`agentic.authz.workflow_write`), asked before the store is touched. Fail-closed: no answer = no. */
async function gate(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<void> {
  const seam = workflowWriteTestGate();
  const ok = seam ? Boolean(await seam(op, user, wf)) : (await authorize(`user:${user.id}`, 'workflow.write', workflowWriteDecision(user, op, wf))).allowed;
  if (!ok) throw Object.assign(new Error(`This workflow change was refused by policy (${op}) — the policy engine did not allow it, or did not answer. Nothing was changed.`), { status: 403 });
}

/**
 * POST → run the indexing pipeline for this workflow (+ its domain card):
 * unit-chunk → embed (sovereign-embed) → OpenSearch (with the in-process mirror).
 * This is what the publish-time Dagster sensor does; exposed here for re-index.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const view = getWorkflow(id, user);
    await gate(user, 'index', workflowFacts(view));
    // A27: attribute the embed spend to the user who asked for the re-index.
    const caller = actingCaller(user.id, view.domain);
    const wfReport = await indexWorkflow(view.workflow, {
      owner: view.owner,
      tacit: view.tacit,
      updatedAt: view.updatedAt,
      caller,
    });
    const domainReport = await indexDomain(getDomainKnowledge(view.domain), caller);
    return NextResponse.json({ workflow: wfReport, domain: domainReport });
}, { defaultStatus: 500 });
