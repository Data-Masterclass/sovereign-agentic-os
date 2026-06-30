/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { decide, getApproval, listApprovals, recordEffect } from '@/lib/approvals';
import { canApprove, canSee, roleLabel } from '@/lib/governance/roles';
import { applyEffect } from '@/lib/governance/effects';
import { record as audit } from '@/lib/governance/audit';
import { remember } from '@/lib/governance/standing';

export const dynamic = 'force-dynamic';

/**
 * The unified Governance inbox API (governance-golden-path.md §1).
 *   GET  -> the queue, SCOPED: Admin = tenant, Builder = own domain, User = own.
 *   POST { id, decision, remember? } -> decide. On approve the platform EXECUTES
 *     the governed effect (deploy/grant/egress/promote/run), records audit, and —
 *     if "approve & remember" — writes a standing policy. An approval IS an action.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const visible = listApprovals().filter((a) => canSee(user, a));
  return NextResponse.json({
    approvals: visible.map((a) => ({ ...a, mayApprove: canApprove(user, a) })),
    pending: visible.filter((a) => a.status === 'pending').length,
    role: roleLabel(user.role),
  });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body: { id?: string; decision?: 'approve' | 'reject'; remember?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const id = String(body?.id ?? '');
  const decision = body?.decision === 'reject' ? 'reject' : 'approve';
  const existing = getApproval(id);
  if (!existing) return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
  if (!canSee(user, existing)) return NextResponse.json({ error: 'Out of scope' }, { status: 403 });
  if (existing.status !== 'pending') {
    return NextResponse.json({ error: `Already ${existing.status}` }, { status: 409 });
  }
  if (!canApprove(user, existing)) {
    const need = existing.scope === 'tenant' ? 'an Administrator' : `a ${roleLabel(existing.approverRole)} of ${existing.domain}`;
    return NextResponse.json({ error: `This item needs ${need}` }, { status: 403 });
  }

  const updated = decide(id, decision, user.id);
  if (!updated) return NextResponse.json({ error: 'Could not decide' }, { status: 500 });

  if (decision === 'reject') {
    audit({
      actor: user.id,
      action: 'deny',
      subject: updated.tool || updated.kind,
      domain: updated.domain,
      reason: `${updated.kind} denied`,
      detail: { approvalId: updated.id },
    });
    return NextResponse.json({ approval: updated, applied: null });
  }

  // Approve === act: execute the governed effect, then audit (+ optional standing).
  let effect;
  try {
    effect = await applyEffect(updated, user.id);
  } catch (e) {
    // The decision stands (item is approved) but the effect failed — record the
    // failure to audit rather than silently dropping it, and surface a 502.
    audit({
      actor: user.id,
      action: 'approve',
      subject: updated.tool || updated.kind,
      domain: updated.domain,
      reason: `Effect FAILED after approval: ${(e as Error).message}`,
      detail: { approvalId: updated.id, error: (e as Error).message },
    });
    recordEffect(updated.id, { applied: `Effect failed: ${(e as Error).message}`, live: false });
    return NextResponse.json({ approval: { ...getApproval(updated.id) }, applied: null, error: 'Effect failed' }, { status: 502 });
  }
  let standingPolicyId: string | undefined;
  if (body?.remember && updated.rememberable) {
    const sp = remember({
      kind: updated.kind,
      payload: updated.payload,
      domain: updated.domain,
      createdBy: user.id,
      fromApproval: updated.id,
    });
    standingPolicyId = sp.id;
  }
  recordEffect(updated.id, { applied: effect.applied, live: effect.live, standingPolicyId });
  audit({
    actor: user.id,
    action: effect.audit.action,
    subject: effect.audit.subject,
    domain: updated.domain,
    reason: effect.audit.reason + (standingPolicyId ? ' (+ standing policy)' : ''),
    detail: { approvalId: updated.id, ...effect.audit.detail, standingPolicyId },
  });

  return NextResponse.json({
    approval: { ...getApproval(updated.id) },
    applied: effect.applied,
    live: effect.live,
    standingPolicyId,
  });
}
