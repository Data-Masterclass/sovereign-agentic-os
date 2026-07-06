/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getArtifact } from '@/lib/artifacts';
import { promoteThroughSeam } from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/** Personal → Shared (Builder+) → Certified (Admin). The flip runs THROUGH the
 *  governance effect seam (never a direct promoteArtifact — back door closed). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    await promoteThroughSeam('artifact', id, user);
    const item = await getArtifact(id);
    return NextResponse.json({ item });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
