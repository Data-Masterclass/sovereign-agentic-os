/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
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
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const r = await promoteOrRequest('app', id, user);
  if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
  const app = await getAppForUser(id, user);
  return NextResponse.json({ app });
}, { defaultStatus: 500 });

/** The pending promotion request for this app (so the UI shows "awaiting approval"). */
export const GET = withRoute<{ id: string }>(async ({ params }) => {
  const { id } = params;
  const request = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'app' && a.payload?.id === id,
  ) ?? null;
  return NextResponse.json({ request });
}, { defaultStatus: 500 });
