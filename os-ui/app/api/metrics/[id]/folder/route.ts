/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { ensureHydrated, moveMetric } from '@/lib/metrics/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * Move a metric into a folder. Runs AS the signed-in user; `moveMetric` is edit-scoped
 * (owner or domain admin of the metric's dataset), so a viewer is rejected 403 and
 * nothing is written. A metric has no store row of its own — the folder path rides the
 * metric lifecycle overlay. Mirrors the item-move routes on Files / Data / Knowledge.
 *
 *   POST /api/metrics/:id/folder  { folder }  → move the metric
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { folder?: string };
    if (typeof body.folder !== 'string') {
      return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
    }
    const metric = moveMetric(id, user, body.folder); // 403 → nothing written
    return NextResponse.json({ metric });
  } catch (e) {
    return errorResponse(e);
  }
}
