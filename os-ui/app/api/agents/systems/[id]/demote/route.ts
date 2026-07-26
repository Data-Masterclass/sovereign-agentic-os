/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getSystem } from '@/lib/agents/store';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/**
 * POST → revoke sharing one rung DOWN the publish ladder for a system:
 *   Marketplace ──(Admin)──▶ Shared ──(owner | in-domain Builder+)──▶ Personal
 * Runs THROUGH the governed demote seam; the store fn re-enforces role + domain.
 * A creator who is not the owner is rejected (403). Never deletes the system.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  await demoteThroughSeam('agent_system', id, user);
  const rec = getSystem(id, user);
  return NextResponse.json({ id: rec.id, visibility: rec.visibility });
}, { defaultStatus: 500 });
