/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { listWorkflows, createWorkflow, ensureHydrated } from '@tabs/knowledge/lib/store';
import { authorize, workflowWriteTestGate, workflowWriteDecision, workflowFacts, type WorkflowOp, type WorkflowFacts } from '@core/infra/governed';
import type { CurrentUser } from '@core/kernel/auth';

export const dynamic = 'force-dynamic';

/** OPA door (`agentic.authz.workflow_write`), asked before the store is touched. Fail-closed: no answer = no. */
async function gate(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<void> {
  const seam = workflowWriteTestGate();
  const ok = seam ? Boolean(await seam(op, user, wf)) : (await authorize(`user:${user.id}`, 'workflow.write', workflowWriteDecision(user, op, wf))).allowed;
  if (!ok) throw Object.assign(new Error(`This workflow change was refused by policy (${op}) — the policy engine did not allow it, or did not answer. Nothing was changed.`), { status: 403 });
}

/** GET → caller's workflows grouped mine / domain / marketplace. Pass ?archived=1 to include archived. */
export const GET = withRoute(async ({ user, req }) => {
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('archived') === '1';
    return NextResponse.json(listWorkflows(user, { includeArchived }));
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/** POST → create a new draft workflow. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<Record<string, string>, any>(async ({ user, body }) => {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return NextResponse.json({ error: 'A workflow title is required.' }, { status: 400 });
    const domain = typeof body.domain === 'string' ? body.domain : undefined;
    await gate(user, 'create', { id: '', tier: 'personal', owner: user.id, domain: domain || user.domains[0] || '' });
    const rec = createWorkflow(user, {
      title,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
    });
    return NextResponse.json({ id: rec.id, title: rec.title });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
