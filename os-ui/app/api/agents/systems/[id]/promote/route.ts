/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSystem } from '@/lib/agents/store';
import { promoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → walk the governed publish ladder for a system:
 *   Personal ──(Builder+)──▶ Shared ──(Admin)──▶ Marketplace
 * The flip runs THROUGH the governance effect seam (never a direct promoteSystem —
 * the former back door is closed); the applier re-enforces the role + domain gate.
 * Rung 1 (Personal→Shared) is owner-only unless a promotion request is already
 * filed. A creator/participant is rejected (403).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await promoteThroughSeam('agent_system', id, user);
    const rec = getSystem(id, user);
    return NextResponse.json({ id: rec.id, visibility: rec.visibility });
  } catch (e) {
    return fail(e);
  }
}
