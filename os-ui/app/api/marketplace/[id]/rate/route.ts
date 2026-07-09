/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { rateListing, type Viewer } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/** Rate a listing 1..5. Body: { stars }. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { stars?: number };
    const stars = Math.max(1, Math.min(5, Number(body.stars) || 0));
    if (!stars) return NextResponse.json({ error: 'stars must be 1..5' }, { status: 400 });
    const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role };
    const agg = rateListing(id, viewer, stars);
    return NextResponse.json(agg);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
