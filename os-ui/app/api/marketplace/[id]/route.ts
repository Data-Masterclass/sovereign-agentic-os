/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listingAdapter, type Viewer } from '@/lib/marketplace';
import { ensureHydrated } from '@/lib/marketplace/store';

export const dynamic = 'force-dynamic';

/**
 * Listing detail: trust signals + lineage + owner-visible importers + a
 * preview/sample RLS-filtered for the requesting viewer (so two domains see
 * different sample rows). `?as=<domain>` lets a multi-domain user preview as a
 * specific domain.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const { id } = await ctx.params;
    const as = new URL(req.url).searchParams.get('as') ?? undefined;
    const viewer: Viewer = { id: user.id, domains: user.domains, role: user.role, activeDomain: as };
    const detail = await listingAdapter.get(id, viewer);
    if (!detail) return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    return NextResponse.json({ detail, source: listingAdapter.source() });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
