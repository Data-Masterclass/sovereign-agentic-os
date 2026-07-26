/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getConnectionForUser } from '@/lib/connections';
import { promoteOrRequest } from '@/lib/governance/ladder';
import { listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

/**
 * Promote a connection one step: Personal → Shared → Marketplace (Admin). Runs
 * THROUGH the governance effect seam. A non-approver OWNER files a promotion REQUEST
 * (a domain_admin+ approves it in Governance) instead of a 403; an approver promotes
 * directly.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const r = await promoteOrRequest('connection', id, user);
    if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
    const connection = await getConnectionForUser(id, user);
    return NextResponse.json({ connection });
}, { defaultStatus: 500 });

/** The pending promotion request for this connection (so the UI shows "awaiting approval"). */
export const GET = withRoute<{ id: string }>(async ({ params }) => {
    const { id } = params;
    const request = listApprovals({ status: 'pending' }).find(
      (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'connection' && a.payload?.id === id,
    ) ?? null;
    return NextResponse.json({ request });
}, { defaultStatus: 500 });
