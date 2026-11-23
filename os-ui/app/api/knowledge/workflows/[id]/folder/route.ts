/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getWorkflow, moveWorkflow, ensureHydrated } from '@tabs/knowledge/lib/store';
import { authorize, workflowWriteTestGate, workflowWriteDecision, workflowFacts, type WorkflowOp, type WorkflowFacts } from '@core/infra/governed';
import type { CurrentUser } from '@core/kernel/auth';
import { folderRowWarning, type EnsureFolderResult } from '@core/folders/index';

export const dynamic = 'force-dynamic';

/** OPA door (`agentic.authz.workflow_write`), asked before the store is touched. Fail-closed: no answer = no. */
async function gate(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<void> {
  const seam = workflowWriteTestGate();
  const ok = seam ? Boolean(await seam(op, user, wf)) : (await authorize(`user:${user.id}`, 'workflow.write', workflowWriteDecision(user, op, wf))).allowed;
  if (!ok) throw Object.assign(new Error(`This workflow change was refused by policy (${op}) — the policy engine did not allow it, or did not answer. Nothing was changed.`), { status: 403 });
}

/**
 * Move a workflow (business process) into a folder. Runs AS the signed-in user;
 * `moveWorkflow` is edit-scoped in the store (owner, in-domain domain_admin, or admin),
 * so a viewer is rejected 403 and nothing is written. The move also upserts an explicit
 * folder row in the governed registry, so the destination folder persists even when empty.
 *
 *   POST /api/knowledge/workflows/:id/folder  { folder }  → move the workflow
 */
export const POST = withRoute<{ id: string }, { folder?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  await gate(user, 'update', workflowFacts(getWorkflow(id, user)));
  let folderRow: EnsureFolderResult | undefined;
  const rec = moveWorkflow(id, user, body.folder, (r) => { folderRow = r; }); // 403 → nothing written
  return NextResponse.json({ workflow: { id: rec.id, title: rec.title, folder: rec.folder, updatedAt: rec.updatedAt }, ...(folderRowWarning(folderRow) ? { folderWarning: folderRowWarning(folderRow) } : {}) });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
