/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getSystem } from '@/lib/agents/store';
import { promoteOrRequest } from '@/lib/governance/ladder';
import { listApprovals } from '@/lib/governance/approvals';

export const dynamic = 'force-dynamic';

/**
 * POST → walk the governed publish ladder for a system:
 *   Personal ──▶ Shared ──(Admin)──▶ Marketplace
 * Runs THROUGH the governance effect seam. A non-approver OWNER (creator/builder)
 * FILES a promotion REQUEST that a domain_admin+ approves in Governance — no more
 * "requires a Domain admin" dead-end; an approver promotes directly.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const r = await promoteOrRequest('agent_system', id, user);
  if (r.requested) return NextResponse.json({ requested: true, approval: r.approval });
  const rec = getSystem(id, user);
  return NextResponse.json({ id: rec.id, visibility: rec.visibility });
}, { defaultStatus: 500 });

/** The pending promotion request for this system (so the UI shows "awaiting approval"). */
export const GET = withRoute<{ id: string }>(async ({ params }) => {
  const { id } = params;
  const request = listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'artifact_promote' && a.payload?.artifactKind === 'agent_system' && a.payload?.id === id,
  ) ?? null;
  return NextResponse.json({ request });
}, { defaultStatus: 500 });
