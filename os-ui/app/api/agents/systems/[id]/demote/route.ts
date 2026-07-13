/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystem } from '@/lib/agents/store';
import { demoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → revoke sharing one rung DOWN the publish ladder for a system:
 *   Marketplace ──(Admin)──▶ Shared ──(owner | in-domain Builder+)──▶ Personal
 * Runs THROUGH the governed demote seam; the store fn re-enforces role + domain.
 * A creator who is not the owner is rejected (403). Never deletes the system.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await demoteThroughSeam('agent_system', id, user);
    const rec = getSystem(id, user);
    return NextResponse.json({ id: rec.id, visibility: rec.visibility });
  } catch (e) {
    return fail(e);
  }
}
