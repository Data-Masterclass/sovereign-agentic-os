/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { errorResponse } from '@core/kernel/route-server';
import { decide, ensureHydrated, getApproval, listApprovals } from '@core/policy/approvals';
import { canApprove, canSee, roleLabel } from '@core/policy/roles';
import { guardAppIntent } from '@core/kernel/app-intent';
import { curateFact, proposeFact } from '@tabs/agents/lib/agent-memory';
import { trace } from '@core/infra/agent-governed';
import {
  applyApprovedCertification,
  type PromotionRequest,
  type CertificationRequest,
} from '@tabs/data/lib/store';
import { publishPromotionLive } from '@tabs/data/lib/publish-server';
import { applyApprovedFilePromotion, type FilePromotionRequest } from '@tabs/files/lib/store';
import { reindexById } from '@tabs/files/lib/pipeline-server';
import { roleAtLeast } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

/**
 * The LEGACY approval queue API (golden path §7) — older than the Governance inbox route
 * (`/api/governance/approvals`), which is the door the UI uses. Kept because a client outside
 * this repository may still call it; its apply-side effects are unchanged.
 *
 * AUTHORISATION IS THE GOVERNANCE ROUTE'S, item by item — the same `canSee` / `canApprove`
 * (`core/policy/roles.ts`) and the same app-intent guard. This route used to gate on a role
 * floor alone ("Builder or above"), which let any Builder decide ANY approval: another domain's
 * item, an admin-only item, and — the one that mattered most — the held call of their OWN
 * parked agent run, which four-eyes forbids. Its GET listed the whole queue, payloads included,
 * to anyone signed in.
 *   GET  -> the queue as the Governance inbox would show it to this user.
 *   POST { id, decision } -> approve/reject, only for a user `canApprove` clears. Approving
 *     APPLIES the write (attributed to the agent + the approving human) and logs it to Langfuse.
 */
export async function GET() {
  await ensureHydrated();
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return errorResponse(e);
  }
  const visible = listApprovals().filter((a) => canSee(user, a));
  return NextResponse.json({
    approvals: visible,
    pending: visible.filter((a) => a.status === 'pending').length,
  });
}

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  // Only Builders/Admins clear the queue (§7: Builder is the approval gate). This floor is the
  // cheap first refusal; the per-item gate below is the rule.
  if (!roleAtLeast(user.role, 'builder')) {
    return NextResponse.json({ error: 'Approving governed writes requires a Builder or Administrator' }, { status: 403 });
  }
  // Deciding an approval is a HUMAN act: a cross-site POST or one presenting an app intent is
  // refused, exactly as on the Governance route.
  const intent = guardAppIntent(req.headers, user, 'approval-decide');
  if (!intent.ok) return NextResponse.json({ error: intent.reason }, { status: intent.status });

  let body: { id?: string; decision?: 'approve' | 'reject' };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const id = (body?.id ?? '').toString();
  const decision = body?.decision === 'reject' ? 'reject' : 'approve';
  await ensureHydrated();
  const existing = getApproval(id);
  if (!existing) return NextResponse.json({ error: 'Approval not found' }, { status: 404 });
  if (!canSee(user, existing)) return NextResponse.json({ error: 'Out of scope' }, { status: 403 });
  if (existing.status !== 'pending') {
    return NextResponse.json({ error: `Already ${existing.status}` }, { status: 409 });
  }
  // THE PER-ITEM GATE, before any effect runs and for approve AND reject: rank ≥ the item's
  // approver role, in scope, and never the requester of a parked agent run's own held call.
  if (!canApprove(user, existing)) {
    const need = existing.scope === 'tenant' ? 'an Administrator' : `a ${roleLabel(existing.approverRole)} of ${existing.domain}`;
    return NextResponse.json({ error: `This item needs ${need}` }, { status: 403 });
  }

  // A dataset promotion APPLIES the tier move (dataset→asset, into Trino) and is
  // gated by role + the transparency gate. Apply it BEFORE recording the decision
  // so a blocked gate leaves the request pending (no faked "approved").
  let applied: string | null = null;
  const principal = { id: user.id, domains: user.domains, role: user.role };
  if (decision === 'approve' && existing.kind === 'dataset_promote') {
    try {
      // T8: the promotion is PHYSICAL — materialize + verify + policy push as the
      // approving Builder; the tier flips only on ✓. A failed publish returns the
      // real error and leaves the request pending (no faked "approved").
      const out = await publishPromotionLive(existing.payload as unknown as PromotionRequest, principal);
      if (!out.ok) {
        return NextResponse.json({ error: `Physical publish failed (tier unchanged): ${out.error}` }, { status: 502 });
      }
      applied = `Published “${out.dataset.name}” → ${out.fqn} (${out.mode}) — a ${out.dataset.visibility} data asset in Trino.`;
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
    }
  } else if (decision === 'approve' && existing.kind === 'dataset_certify') {
    try {
      const product = applyApprovedCertification(existing.payload as unknown as CertificationRequest, principal);
      applied = `Certified “${product.name}” as a ${product.certification?.level} data product and listed it in the marketplace.`;
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
    }
  }
  // A FILE promotion: move dataset→asset and re-govern the object-store prefix + DLS.
  // Applied before recording the decision so a blocked gate leaves the request pending.
  if (decision === 'approve' && existing.kind === 'file_promote') {
    try {
      const asset = applyApprovedFilePromotion(existing.payload as unknown as FilePromotionRequest, {
        id: user.id, domains: user.domains, role: user.role,
      });
      applied = `Shared “${asset.name}” with the ${asset.domain} domain (${asset.visibility} asset). It is now searchable for domain members only.`;
      await reindexById(asset.id, user.id); // A27 + re-index so the hybrid index's DLS metadata follows the new tier/grants
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
    }
  }

  const updated = decide(id, decision, user.id);
  if (!updated) return NextResponse.json({ error: 'Could not decide' }, { status: 500 });

  // On approval, APPLY the held write + record provenance (agent + human).
  // dataset_promote + dataset_certify + file_promote are already applied above.
  if (decision === 'approve' && updated.kind !== 'dataset_promote' && updated.kind !== 'dataset_certify' && updated.kind !== 'file_promote') {
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
