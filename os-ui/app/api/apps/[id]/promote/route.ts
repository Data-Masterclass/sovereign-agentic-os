/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { promoteOrRequest } from '@/lib/governance/ladder';
import { listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

/**
 * Promote an app one step: Personal → Shared → Marketplace (Admin). Runs THROUGH the
 * governance effect seam. A non-approver OWNER files a promotion REQUEST (a
 * domain_admin+ approves it in Governance) instead of a 403; an approver promotes
 * directly.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const r = await promoteOrRequest('app', id, user);
    if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
    const app = await getAppForUser(id, user);
    return NextResponse.json({ app });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/** The pending promotion request for this app (so the UI shows "awaiting approval"). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await ctx.params;
    const request = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'app' && a.payload?.id === id,
    ) ?? null;
    return NextResponse.json({ request });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
