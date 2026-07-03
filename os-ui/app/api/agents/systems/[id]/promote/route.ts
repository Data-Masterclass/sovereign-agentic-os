/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { promoteSystem } from '@/lib/agents/store';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → walk the governed publish ladder for a system:
 *   Personal ──(Builder+)──▶ Shared ──(Admin)──▶ Marketplace
 * The role gate lives in `promoteSystem` (the store is the security boundary);
 * middleware lets every /api/* through, so this route + that gate are the real
 * control. A creator/participant is rejected (403).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const rec = promoteSystem(id, user);
    return NextResponse.json({ id: rec.id, visibility: rec.visibility });
  } catch (e) {
    return fail(e);
  }
}
