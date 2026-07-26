/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getArtifact } from '@/lib/core/artifacts';
import { promoteOrRequest } from '@/lib/governance/ladder';
import { listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

/** Personal → Shared → Certified. Runs THROUGH the governance effect seam. A
 *  non-approver OWNER files a promotion REQUEST (approved by a domain_admin+ in
 *  Governance) instead of being dead-ended; an approver promotes directly. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const r = await promoteOrRequest('artifact', id, user);
  if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
  const item = await getArtifact(id);
  return NextResponse.json({ item });
}, { defaultStatus: 500 });

/** The pending promotion request for this artifact (so the UI shows "awaiting approval"). */
export const GET = withRoute<{ id: string }>(async ({ params }) => {
  const { id } = params;
  const request = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'artifact' && a.payload?.id === id,
  ) ?? null;
  return NextResponse.json({ request });
}, { defaultStatus: 500 });
