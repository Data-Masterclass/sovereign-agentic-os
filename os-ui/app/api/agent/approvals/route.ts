/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { decide, getApproval, listApprovals } from '@/lib/approvals';
import { curateFact, proposeFact } from '@/lib/agent-memory';
import { trace } from '@/lib/agent-governed';
import {
  applyApprovedCertification,
  type PromotionRequest,
  type CertificationRequest,
} from '@/lib/data/store';
import { publishPromotionLive } from '@/lib/data/publish-server';
import { applyApprovedFilePromotion, type FilePromotionRequest } from '@/lib/files/store';
import { reindexById } from '@/lib/files/pipeline-server';
import { listLineage } from '@/lib/files/lineage';
import { pushLineage } from '@/lib/files/catalog';
import { onApprovalDecided } from '@/lib/marketplace';
import { roleAtLeast } from '@/lib/session';

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
  if (!roleAtLeast(user.role, 'builder')) {
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
  // A FILE promotion: move dataset→asset, re-govern the object-store prefix + DLS,
  // and mirror the lineage to OpenMetadata (best-effort). Applied before recording
  // the decision so a blocked gate leaves the request pending.
  if (decision === 'approve' && existing.kind === 'file_promote') {
    try {
      const asset = applyApprovedFilePromotion(existing.payload as unknown as FilePromotionRequest, {
        id: user.id, domains: user.domains, role: user.role,
      });
      applied = `Shared “${asset.name}” with the ${asset.domain} domain (${asset.visibility} asset). It is now searchable for domain members only.`;
      await reindexById(asset.id); // re-index so the hybrid index's DLS metadata follows the new tier/grants
      const latest = listLineage(asset.id)[0];
      if (latest) void pushLineage(latest);
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

  // Marketplace imports gated by approval: flip the pending grant active/revoked.
  if (updated.kind === 'marketplace_import') {
    const grant = await onApprovalDecided(updated.id, decision);
    if (grant) applied = decision === 'approve' ? `Import grant activated for ${grant.granteeDomain}.` : 'Import request rejected.';
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
