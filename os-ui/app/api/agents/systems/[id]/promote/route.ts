/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystem } from '@/lib/agents/store';
import { promoteOrRequest } from '@/lib/governance/ladder';
import { listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → walk the governed publish ladder for a system:
 *   Personal ──▶ Shared ──(Admin)──▶ Marketplace
 * Runs THROUGH the governance effect seam. A non-approver OWNER (creator/builder)
 * FILES a promotion REQUEST that a domain_admin+ approves in Governance — no more
 * "requires a Domain admin" dead-end; an approver promotes directly.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const r = await promoteOrRequest('agent_system', id, user);
    if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
    const rec = getSystem(id, user);
    return NextResponse.json({ id: rec.id, visibility: rec.visibility });
  } catch (e) {
    return fail(e);
  }
}

/** The pending promotion request for this system (so the UI shows "awaiting approval"). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const request = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'agent_system' && a.payload?.id === id,
    ) ?? null;
    return NextResponse.json({ request });
  } catch (e) {
    return fail(e);
  }
}
