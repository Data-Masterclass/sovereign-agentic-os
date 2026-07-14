/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getDashboard } from '@/lib/dashboards/store';
import { promoteOrRequest } from '@/lib/governance/ladder';
import { listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

/** Personal → Shared → Certified for a dashboard, running THROUGH the governance
 *  effect seam. A non-approver OWNER files a promotion REQUEST (approved by a
 *  domain_admin+ in Governance) instead of being dead-ended; an approver promotes
 *  directly. The rung is derived from the dashboard's current tier. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const r = await promoteOrRequest('dashboard', id, user);
    if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
    const dashboard = getDashboard(id, user);
    return NextResponse.json({ dashboard });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/** The pending promotion request for this dashboard (so the UI shows "awaiting approval"). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const request = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'dashboard' && a.payload?.id === id,
    ) ?? null;
    return NextResponse.json({ request });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
