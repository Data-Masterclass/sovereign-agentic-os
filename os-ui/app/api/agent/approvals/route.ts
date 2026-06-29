/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { decide, getApproval, listApprovals } from '@/lib/approvals';
import { curateFact, proposeFact } from '@/lib/agent-memory';
import { trace } from '@/lib/agent-governed';

export const dynamic = 'force-dynamic';

/**
 * Governance approval queue API (golden path §7). Held write-backs (connection
 * writes, knowledge certify, file promotes) surface here for a Builder/Admin.
 *   GET  -> the queue (everyone signed in can watch; UI gates the buttons).
 *   POST { id, decision } -> approve/reject. Approving APPLIES the write
 *     (attributed to the agent + the approving human) and logs it to Langfuse.
 */
export async function GET() {
  try {
    await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const all = listApprovals();
  return NextResponse.json({
    approvals: all,
    pending: all.filter((a) => a.status === 'pending').length,
  });
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  // Only Builders/Admins clear the queue (§7: Builder is the approval gate).
  if (user.role !== 'builder' && user.role !== 'admin') {
    return NextResponse.json({ error: 'Approving governed writes requires a Builder or Administrator' }, { status: 403 });
  }

  let body: { id?: string; decision?: 'approve' | 'reject' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const id = (body?.id ?? '').toString();
  const decision = body?.decision === 'reject' ? 'reject' : 'approve';
  const existing = getApproval(id);
  if (!existing) return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
  if (existing.status !== 'pending') {
    return NextResponse.json({ error: `Already ${existing.status}` }, { status: 409 });
  }

  const updated = decide(id, decision, user.id);
  if (!updated) return NextResponse.json({ error: 'Could not decide' }, { status: 500 });

  // On approval, APPLY the held write + record provenance (agent + human).
  let applied: string | null = null;
  if (decision === 'approve') {
    if (updated.kind === 'connection_write') {
      applied = `CRM write applied to ${String(updated.payload.account ?? 'account')} (${String(updated.payload.field ?? 'field')}=${String(updated.payload.value ?? '')}).`;
      // Record the now-confirmed renewal date as a durable semantic fact.
      proposeFact({
        domain: updated.domain,
        agent: updated.agent,
        kind: 'semantic',
        text: `${String(updated.payload.account ?? 'Account')} renewal touch logged to CRM on ${String(updated.payload.value ?? '')} (approved by ${user.id}).`,
        provenance: `approval:${updated.id}`,
      });
    } else if (updated.kind === 'knowledge_certify') {
      const f = updated.payload.factId ? curateFact(String(updated.payload.factId)) : null;
      applied = f ? `Knowledge fact certified into MEMORY.md.` : 'Certified.';
    } else {
      applied = 'Promotion applied.';
    }
  }

  await trace({
    principal: updated.agent,
    tool: 'connection_crm_write',
    input: { approvalId: updated.id, decision, by: user.id },
    output: { status: updated.status, applied },
    decision: decision === 'approve' ? 'allow' : 'deny',
  });

  return NextResponse.json({ approval: updated, applied });
}
