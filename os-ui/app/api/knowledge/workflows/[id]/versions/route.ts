/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import { codedError } from '@core/kernel/server-message';
import { ensureHydrated, getWorkflow, listWorkflowVersions, restoreWorkflowVersion } from '@tabs/knowledge/lib/store';
import { authorize, workflowWriteTestGate, workflowWriteDecision, workflowFacts, type WorkflowOp, type WorkflowFacts } from '@core/infra/governed';
import type { CurrentUser } from '@core/kernel/auth';

export const dynamic = 'force-dynamic';

/** OPA door (`agentic.authz.workflow_write`), asked before the store is touched. Fail-closed: no answer = no. */
async function gate(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<void> {
  const seam = workflowWriteTestGate();
  const ok = seam ? Boolean(await seam(op, user, wf)) : (await authorize(`user:${user.id}`, 'workflow.write', workflowWriteDecision(user, op, wf))).allowed;
  if (!ok) throw codedError(403, `This workflow change was refused by policy (${op}) — the policy engine did not allow it, or did not answer. Nothing was changed.`, 'workflows.policyRefused', { op });
}

/**
 * Version history for one knowledge workflow.
 *   GET          → the versions (newest first; view-scoped).
 *   POST {version} → restore a prior version (edit-scoped; itself snapshots the
 *                    current state first, so the restore is reversible).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const list = listWorkflowVersions(id, user).map((v) => ({
      version: v.version,
      at: v.at,
      author: v.author,
      summary: v.summary,
    }));
    return NextResponse.json({ versions: list });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

export const POST = withRoute<{ id: string }, { version?: number }>(async ({ user, params, body }) => {
    const { id } = params;
    if (typeof body.version !== 'number') {
      return apiError(400, 'A version number is required.', 'knowledge.versionNumberRequired');
    }
    await gate(user, 'update', workflowFacts(getWorkflow(id, user)));
    const rec = restoreWorkflowVersion(id, user, body.version);
    return NextResponse.json({ id: rec.id, updatedAt: rec.updatedAt });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
